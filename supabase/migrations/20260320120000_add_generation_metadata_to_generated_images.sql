alter table public.generated_images
  add column if not exists quality text,
  add column if not exists requested_count integer,
  add column if not exists reference_images jsonb default '[]'::jsonb;
