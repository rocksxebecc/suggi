-- ================================================================
-- ZENSPACE — Delete Server For All Users Patch
-- Run this in Supabase Dashboard → SQL Editor
-- ================================================================

-- 1. Create a secure RPC function that deletes a server and all its child data
CREATE OR REPLACE FUNCTION public.delete_server_for_all(p_server_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_id UUID;
  v_server_name TEXT;
BEGIN
  -- Verify server exists and get owner
  SELECT owner_id, name INTO v_owner_id, v_server_name
  FROM public.servers
  WHERE id = p_server_id;

  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Server not found');
  END IF;

  -- Only server owner can delete it
  IF v_owner_id != auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized: Only the server owner can delete this server');
  END IF;

  -- Clean up voice tables if present
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'voice_signals') THEN
    DELETE FROM public.voice_signals WHERE server_id = p_server_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'voice_sessions') THEN
    DELETE FROM public.voice_sessions WHERE server_id = p_server_id;
  END IF;

  -- Delete all messages in the server
  DELETE FROM public.server_messages WHERE server_id = p_server_id;

  -- Delete ALL member records (for all users, not just the owner)
  DELETE FROM public.server_members WHERE server_id = p_server_id;

  -- Delete the server row itself
  DELETE FROM public.servers WHERE id = p_server_id;

  RETURN jsonb_build_object('success', true, 'server_id', p_server_id, 'server_name', v_server_name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_server_for_all(UUID) TO authenticated;

-- 2. Update RLS policies on server_members so owner can delete any membership
DROP POLICY IF EXISTS "Users can leave servers" ON public.server_members;
DROP POLICY IF EXISTS "Users can leave or owner can remove members" ON public.server_members;
CREATE POLICY "Users can leave or owner can remove members"
  ON public.server_members FOR DELETE
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.servers
      WHERE id = server_members.server_id AND owner_id = auth.uid()
    )
  );

-- 3. Add DELETE policy on server_messages so owner or sender can delete
DROP POLICY IF EXISTS "Owner can delete server messages" ON public.server_messages;
CREATE POLICY "Owner can delete server messages"
  ON public.server_messages FOR DELETE
  USING (
    sender_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.servers
      WHERE id = server_messages.server_id AND owner_id = auth.uid()
    )
  );

-- 4. Ensure Realtime is enabled for servers and server_members tables
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.servers;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.server_members;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;
