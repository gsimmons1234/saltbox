const SUPABASE_URL = "https://plpkvifafggqzxpsyiie.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_MJ12CHcOzQTd_yRrIAt3tQ_AAKEmEJ9";

const missingSupabaseConfig = [SUPABASE_URL, SUPABASE_ANON_KEY].some(
  (value) => !value || value.startsWith("PASTE_")
);

export const supabaseReady = !missingSupabaseConfig;

export const supabaseConfigError =
  "Supabase is not configured yet. Add the project URL and anon public key in supabase-client.js.";

let client = null;

if (supabaseReady) {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export const supabase = client;
