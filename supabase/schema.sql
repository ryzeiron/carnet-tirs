-- =====================================================================
-- Carnet de tirs : base de données pour la synchronisation en équipe
-- À coller une seule fois dans Supabase > SQL Editor > New query > Run
-- =====================================================================

-- 1. Les tables -------------------------------------------------------

-- Une équipe (ex. « Seniors Garçons »)
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Les membres du staff, invités par e-mail, avec leur rôle
create table if not exists public.members (
  team_id uuid not null references public.teams(id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('admin', 'analyste', 'lecteur')),
  invited_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (team_id, email)
);
create index if not exists members_user_idx on public.members(user_id);

-- Toutes les données de l'appli : joueurs, matchs, actions, réglages
create table if not exists public.items (
  team_id uuid not null references public.teams(id) on delete cascade,
  kind text not null check (kind in ('player', 'match', 'shot', 'cfg')),
  id text not null check (char_length(id) <= 80),
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (team_id, kind, id)
);
create index if not exists items_sync_idx on public.items(team_id, updated_at);

-- 2. Les fonctions ----------------------------------------------------

-- Rôle de la personne connectée dans une équipe (null si elle n'en fait pas partie)
create or replace function public.my_role(t uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members
  where team_id = t
    and (user_id = auth.uid() or email = lower(coalesce(auth.jwt() ->> 'email', '')))
  order by case role when 'admin' then 1 when 'analyste' then 2 else 3 end
  limit 1
$$;

-- Créer une équipe : la personne connectée en devient l'admin
create or replace function public.create_team(team_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  tid uuid;
  em text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or em = '' then
    raise exception 'Connexion requise';
  end if;
  insert into public.teams(name, created_by) values (trim(team_name), auth.uid()) returning id into tid;
  insert into public.members(team_id, email, user_id, role, invited_by) values (tid, em, auth.uid(), 'admin', auth.uid());
  return tid;
end $$;

-- À la connexion : relie les invitations reçues par e-mail au compte
create or replace function public.claim_invites() returns void
language sql security definer set search_path = public as $$
  update public.members set user_id = auth.uid()
  where user_id is null and email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Horodatage côté serveur (sert à la synchronisation)
create or replace function public.items_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
for each row execute function public.items_touch();

revoke all on function public.my_role(uuid) from public, anon;
revoke all on function public.create_team(text) from public, anon;
revoke all on function public.claim_invites() from public, anon;
grant execute on function public.my_role(uuid) to authenticated;
grant execute on function public.create_team(text) to authenticated;
grant execute on function public.claim_invites() to authenticated;

-- 3. Les droits (sécurité) -------------------------------------------
-- admin : tout ; analyste : saisit ; lecteur : consulte seulement

alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.items enable row level security;

revoke all on public.teams, public.members, public.items from anon;
grant select, update, delete on public.teams to authenticated;
grant select, insert, update, delete on public.members to authenticated;
grant select, insert, update on public.items to authenticated;

drop policy if exists teams_read on public.teams;
drop policy if exists teams_update on public.teams;
drop policy if exists teams_delete on public.teams;
create policy teams_read on public.teams for select to authenticated
  using (public.my_role(id) is not null);
create policy teams_update on public.teams for update to authenticated
  using (public.my_role(id) = 'admin') with check (public.my_role(id) = 'admin');
create policy teams_delete on public.teams for delete to authenticated
  using (public.my_role(id) = 'admin');

drop policy if exists members_read on public.members;
drop policy if exists members_insert on public.members;
drop policy if exists members_update on public.members;
drop policy if exists members_delete on public.members;
create policy members_read on public.members for select to authenticated
  using (public.my_role(team_id) is not null);
create policy members_insert on public.members for insert to authenticated
  with check (public.my_role(team_id) = 'admin');
create policy members_update on public.members for update to authenticated
  using (public.my_role(team_id) = 'admin') with check (public.my_role(team_id) = 'admin');
create policy members_delete on public.members for delete to authenticated
  using (public.my_role(team_id) = 'admin');

drop policy if exists items_read on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;
create policy items_read on public.items for select to authenticated
  using (public.my_role(team_id) is not null);
create policy items_insert on public.items for insert to authenticated
  with check (public.my_role(team_id) in ('admin', 'analyste'));
create policy items_update on public.items for update to authenticated
  using (public.my_role(team_id) in ('admin', 'analyste'))
  with check (public.my_role(team_id) in ('admin', 'analyste'));

-- 4. Le temps réel (les saisies arrivent tout de suite chez les autres)
do $$
begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null;
end $$;
