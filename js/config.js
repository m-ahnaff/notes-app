// Supabase project settings.
//
// Paste your project's values here (Supabase dashboard → Project Settings → API):
//   SUPABASE_URL      e.g. "https://abcdefghijklmnop.supabase.co"
//   SUPABASE_ANON_KEY the "anon" / "publishable" key (NOT the service_role / secret key)
//
// The anon (publishable) key is safe to ship in a public static site: it only
// identifies your project. Every read and write is still checked by Postgres
// Row Level Security (see supabase/schema.sql), which restricts each signed-in
// user to rows where user_id = auth.uid(). Never put the service_role key here.
//
// While both values are empty the app runs in Demo mode (notes stay in this browser).
export const SUPABASE_URL = 'https://rdtdiqbfjzddwmzgmcnq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Bp2bJtkZ8WH15VRsbMKG6g_lolosxd-';
