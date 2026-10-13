-- Carnet de tirs : super-administrateur de l'appli (voit et gère toutes les équipes, sauf les espaces perso)
create table if not exists public.app_admins (email text primary key check (email = lower(email)));
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;
insert into public.app_admins(email) values ('antoningiolda@gmail.com') on conflict do nothing;

create or replace function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.app_admins where email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;
revoke all on function public.is_super() from public, anon;
grant execute on function public.is_super() to authenticated;

-- Le super-admin est admin de toutes les équipes (pas des espaces perso des autres)
create or replace function public.my_role(t uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.is_super() and exists(select 1 from public.teams where id = t and name <> '__perso__') then 'admin'
    else (select role from public.members
          where team_id = t and (user_id = auth.uid() or email = lower(coalesce(auth.jwt() ->> 'email', '')))
          order by case role when 'admin' then 1 when 'analyste' then 2 else 3 end
          limit 1)
  end
$$;

-- Liste de toutes les équipes, réservée au super-admin
create or replace function public.admin_list_teams()
returns table(id uuid, name text, created_at timestamptz, members int, admins text, items int)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.created_at,
    (select count(*)::int from public.members m where m.team_id = t.id),
    (select string_agg(m.email, ', ' order by m.email) from public.members m where m.team_id = t.id and m.role = 'admin'),
    (select count(*)::int from public.items i where i.team_id = t.id and not i.deleted)
  from public.teams t
  where public.is_super() and t.name <> '__perso__'
  order by t.created_at desc
$$;
revoke all on function public.admin_list_teams() from public, anon;
grant execute on function public.admin_list_teams() to authenticated;
