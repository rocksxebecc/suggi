-- ══════════════════════════════════════════════════════════════════
--  profile_images_patch.sql
--  Run this once in your Supabase SQL editor.
--  Fixes: "new row violates row-level security policy" on photo upload
-- ══════════════════════════════════════════════════════════════════

-- 1. Add avatar_url and banner_url columns to profiles (safe – skips if already exists)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS avatar_url  TEXT,
  ADD COLUMN IF NOT EXISTS banner_url  TEXT;

-- 2. Create the storage bucket (public so images are readable by everyone)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'profile-images',
  'profile-images',
  true,
  10485760,   -- 10 MB max
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO UPDATE SET
  public            = true,
  file_size_limit   = 10485760,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'];

-- 3. RLS policies on storage.objects for the profile-images bucket
--    (Drop first so re-running is safe)

DROP POLICY IF EXISTS "profile-images: authenticated users can upload their own files"
  ON storage.objects;
DROP POLICY IF EXISTS "profile-images: authenticated users can update their own files"
  ON storage.objects;
DROP POLICY IF EXISTS "profile-images: authenticated users can delete their own files"
  ON storage.objects;
DROP POLICY IF EXISTS "profile-images: public read"
  ON storage.objects;

-- Anyone logged in can upload into avatars/<their-uid>... or banners/<their-uid>...
CREATE POLICY "profile-images: authenticated users can upload their own files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'profile-images'
    AND (
      name LIKE 'avatars/' || auth.uid() || '.%'
      OR name LIKE 'banners/' || auth.uid() || '.%'
    )
  );

-- Allow overwrite / upsert
CREATE POLICY "profile-images: authenticated users can update their own files"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'profile-images'
    AND (
      name LIKE 'avatars/' || auth.uid() || '.%'
      OR name LIKE 'banners/' || auth.uid() || '.%'
    )
  );

-- Allow deleting their own files
CREATE POLICY "profile-images: authenticated users can delete their own files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'profile-images'
    AND (
      name LIKE 'avatars/' || auth.uid() || '.%'
      OR name LIKE 'banners/' || auth.uid() || '.%'
    )
  );

-- Public read (bucket is already public, but explicit policy is safer)
CREATE POLICY "profile-images: public read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'profile-images');
