-- =========================================================
-- USEPT Score Dashboard - Skema Supabase (idempoten)
-- Jalankan di SQL Editor Supabase.
-- =========================================================

-- 1. Daftar admin yang boleh login & scraping
create table if not exists public.admins (
  email      text primary key,
  nama       text,
  role       text not null default 'admin' check (role in ('super_admin','admin')),
  created_at timestamptz not null default now()
);

-- Ganti dengan email Google Anda
insert into public.admins (email, nama, role)
values ('email-anda@gmail.com', 'Super Admin', 'super_admin')
on conflict (email) do nothing;

-- Fungsi cek admin (dipakai RLS)
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- 2. Score USEPT Mahasiswa (modul suliet_score)
create table if not exists public.score_mahasiswa (
  id              bigserial primary key,
  no_urut         integer,
  pin             text,
  nomor_peserta   text not null unique,
  nim             text,
  nama            text,
  telp_hp         text,
  tanggal_lahir   date,
  tanggal_test    date,
  fakultas        text,
  program_studi   text,
  listening       numeric,
  reading         numeric,
  structure       numeric,
  score           numeric,
  keterangan      text,
  sumber_url      text,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_sm_tgl     on public.score_mahasiswa (tanggal_test);
create index if not exists idx_sm_fak     on public.score_mahasiswa (fakultas);
create index if not exists idx_sm_prodi   on public.score_mahasiswa (program_studi);

-- 3. Score USEPT Umum (modul suliet_score_umum)
create table if not exists public.score_umum (
  id                bigserial primary key,
  no_urut           integer,
  pin               text,
  nomor_peserta     text not null unique,
  nomor_identitas   text,
  nama              text,
  telp_hp           text,
  tanggal_lahir     date,
  tanggal_test      date,
  instansi          text,
  listening         numeric,
  reading           numeric,
  structure         numeric,
  score             numeric,
  certificate_number text,
  sumber_url        text,
  updated_at        timestamptz not null default now()
);
create index if not exists idx_su_tgl on public.score_umum (tanggal_test);

-- 4. Log scraping
create table if not exists public.scrape_logs (
  id          bigserial primary key,
  sumber      text not null,            -- 'mahasiswa' | 'umum'
  tgl_mulai   date,
  tgl_selesai date,
  jumlah      integer default 0,
  status      text,                     -- 'sukses' | 'gagal'
  pesan       text,
  oleh        text,
  created_at  timestamptz not null default now()
);

-- =========================================================
-- RLS: hanya admin terdaftar yang bisa membaca.
-- Penulisan dilakukan Edge Function memakai service_role (melewati RLS).
-- =========================================================
alter table public.admins          enable row level security;
alter table public.score_mahasiswa enable row level security;
alter table public.score_umum      enable row level security;
alter table public.scrape_logs     enable row level security;

drop policy if exists "admin baca admins"  on public.admins;
create policy "admin baca admins" on public.admins
  for select to authenticated using (public.is_admin());

drop policy if exists "admin baca mahasiswa" on public.score_mahasiswa;
create policy "admin baca mahasiswa" on public.score_mahasiswa
  for select to authenticated using (public.is_admin());

drop policy if exists "admin baca umum" on public.score_umum;
create policy "admin baca umum" on public.score_umum
  for select to authenticated using (public.is_admin());

drop policy if exists "admin baca log" on public.scrape_logs;
create policy "admin baca log" on public.scrape_logs
  for select to authenticated using (public.is_admin());

-- Tidak ada policy insert/update/delete untuk authenticated => ditolak.
-- Data Score hanya bisa ditulis oleh service_role (Edge Function).

-- =========================================================
-- View ringkasan untuk dashboard (opsional, mempercepat query)
-- =========================================================
create or replace view public.v_statistik_mahasiswa as
select
  count(*)                    as total,
  round(avg(score), 2)        as rata_rata,
  max(score)                  as tertinggi,
  min(score)                  as terendah,
  count(distinct fakultas)    as jumlah_fakultas,
  count(distinct program_studi) as jumlah_prodi
from public.score_mahasiswa;
