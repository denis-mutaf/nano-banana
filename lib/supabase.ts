import { createClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:54321";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "public-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key";

export const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
);

