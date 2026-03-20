alter table public.generated_images
  add column if not exists estimated_cost_usd numeric(12, 6),
  add column if not exists currency text default 'USD',
  add column if not exists model text,
  add column if not exists pricing_version text;

alter table public.generated_images
  add constraint generated_images_estimated_cost_usd_check
  check (estimated_cost_usd is null or estimated_cost_usd >= 0);
