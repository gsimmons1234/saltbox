-- Saltbox Lead Engine targeted status-flexibility patch.
-- Apply this to an existing Phase 1 database instead of rerunning the full
-- supabase-lead-engine-schema.sql migration.
-- It changes only public.lead_status_transitions(): normal admin-managed
-- statuses become freely movable, Opted Out remains terminal, and the
-- existing transition trigger continues to require dedicated RPCs for
-- entering Opted Out and Duplicate.

BEGIN;

create or replace function public.lead_status_transitions(p_status text)
returns text[]
language sql
immutable
as $$
  select case
    when p_status = 'Opted Out' then array[]::text[]
    when p_status = 'Duplicate' then array[
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress',
      'Draft Ready', 'Approved to Send', 'Contacted', 'Follow-up Due', 'Replied', 'Rejected'
    ]
    when p_status = any(array[
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress',
      'Draft Ready', 'Approved to Send', 'Contacted', 'Follow-up Due', 'Replied', 'Rejected'
    ])
    then array_remove(array[
      'Discovered', 'Needs Review', 'Approved for Mockup', 'Mockup In Progress',
      'Draft Ready', 'Approved to Send', 'Contacted', 'Follow-up Due', 'Replied', 'Rejected',
      'Opted Out', 'Duplicate'
    ], p_status)
    else array[]::text[]
  end;
$$;

COMMIT;
