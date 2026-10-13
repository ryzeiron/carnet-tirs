-- Carnet de tirs : autoriser les données d'entraînement (séances et tirs) dans la synchronisation
alter table public.items drop constraint if exists items_kind_check;
alter table public.items add constraint items_kind_check
  check (kind in ('player', 'match', 'shot', 'cfg', 'train', 'tshot'));
