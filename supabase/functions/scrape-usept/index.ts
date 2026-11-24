// supabase/functions/scrape-usept/index.ts
// Deploy : supabase functions deploy scrape-usept
// Secret : supabase secrets set USEPT_PHPSESSID=isi_cookie_phpsessid
//          (opsional) supabase secrets set USEPT_BASE_URL=https://suliet.unsri.ac.id/usept/admsuliet/module
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseHTML } from "npm:linkedom@0.16.11";

const BASE = Deno.env.get("USEPT_BASE_URL") ??
  "https://suliet.unsri.ac.id/usept/admsuliet/module";
const PHPSESSID = Deno.env.get("USEPT_PHPSESSID") ?? "";

const SUMBER = {
  mahasiswa: { path: "suliet_score/", table: "score_mahasiswa" },
  umum:      { path: "suliet_score_umum/", table: "score_umum" },
} as const;
type Sumber = keyof typeof SUMBER;

// Pemetaan header tabel -> kolom database (kunci dicocokkan terpanjang lebih dulu)
const PETA_KOLOM: Record<string, string> = {
  "nomor peserta": "nomor_peserta",
  "nomor identitas": "nomor_identitas",
  "certificate number": "certificate_number",
  "instansi": "instansi",
  "universitas": "instansi",
  "sekolah": "instansi",
  "program studi": "program_studi",
  "fakultas": "fakultas",
  "tanggal lahir": "tanggal_lahir",
  "tanggal test": "tanggal_test",
  "telp": "telp_hp",
  "hp": "telp_hp",
  "nama": "nama",
  "nim": "nim",
  "pin": "pin",
  "listening": "listening",
  "reading": "reading",
  "structure": "structure",
  "score": "score",
  "keterangan": "keterangan",
  "no": "no_urut",
};

const norm = (s: string) =>
  s.toLowerCase().replace(/[\/.\-_]/g, " ").replace(/\s+/g, " ").trim();

function petaHeader(teks: string): string | null {
  const n = norm(teks);
  if (PETA_KOLOM[n]) return PETA_KOLOM[n];
  const kunci = Object.keys(PETA_KOLOM).sort((a, b) => b.length - a.length);
  for (const k of kunci) if (n.includes(k)) return PETA_KOLOM[k];
  return null;
}

// Mendukung dd-mm-yyyy, dd/mm/yyyy, yyyy-mm-dd
function parseTanggal(raw: string): string | null {
  const t = raw.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function parseAngka(raw: string): number | null {
  const n = Number(raw.replace(",", ".").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) && raw.trim() !== "" ? n : null;
}

// Mengubah HTML tabel menjadi array objek sesuai nama kolom database
function parseTabel(html: string) {
  const { document } = parseHTML(html);
  const tabel = document.querySelector("table");
  if (!tabel) return [];

  const baris = Array.from(tabel.querySelectorAll("tr"));
  const headerRow = baris.find((r) => r.querySelectorAll("th").length > 0) ??
    baris[0];
  const headers = Array.from(headerRow.querySelectorAll("th,td")).map((c) =>
    petaHeader(c.textContent ?? "")
  );

  const hasil: Record<string, unknown>[] = [];
  for (const r of baris) {
    if (r === headerRow) continue;
    const sel = Array.from(r.querySelectorAll("td"));
    if (sel.length === 0) continue;
    const obj: Record<string, unknown> = {};
    sel.forEach((cell, i) => {
      const kolom = headers[i];
      if (!kolom) return;
      const teks = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
      if (kolom === "tanggal_lahir" || kolom === "tanggal_test") {
        obj[kolom] = parseTanggal(teks);
      } else if (["listening", "reading", "structure", "score", "no_urut"].includes(kolom)) {
        obj[kolom] = parseAngka(teks);
      } else {
        obj[kolom] = teks || null;
      }
    });
    if (obj.nomor_peserta) hasil.push(obj);
  }
  return hasil;
}

async function ambilHalaman(sumber: Sumber, tglAwal: string, tglAkhir: string, page: number) {
  // TODO: sesuaikan nama parameter filter dengan URL asli saat Anda melihat
  // hasil pencarian di browser (contoh: ?tgl_awal=...&tgl_akhir=...&page=...)
  const url = new URL(BASE + "/" + SUMBER[sumber].path);
  url.searchParams.set("tgl_awal", tglAwal);
  url.searchParams.set("tgl_akhir", tglAkhir);
  url.searchParams.set("page", String(page));

  const res = await fetch(url.toString(), {
    headers: {
      Cookie: `PHPSESSID=${PHPSESSID}`,
      "User-Agent": "Mozilla/5.0 (USEPT-Dashboard)",
    },
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error("Sesi PHPSESSID kedaluwarsa atau tidak valid (diarahkan ke login).");
  }
  const html = await res.text();
  if (/login\.php|name=["']password["']/i.test(html) && !/<table/i.test(html)) {
    throw new Error("Sesi PHPSESSID kedaluwarsa. Perbarui secret USEPT_PHPSESSID.");
  }
  return html;
}

function tambahSumberUrl(rows: Record<string, unknown>[], sumber: Sumber) {
  const url = BASE + "/" + SUMBER[sumber].path;
  return rows.map((r) => ({ ...r, sumber_url: url }));
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    // 1. Verifikasi login Google (JWT Supabase Auth)
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supaUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user?.email) return json({ error: "Belum login" }, 401);

    // 2. Pastikan user terdaftar sebagai admin / super admin
    const admin = createClient(supaUrl, serviceKey);
    const { data: adm } = await admin
      .from("admins").select("role").ilike("email", user.email).maybeSingle();
    if (!adm) return json({ error: "Hanya Administrator yang boleh scraping" }, 403);

    if (!PHPSESSID) return json({ error: "Secret USEPT_PHPSESSID belum diatur" }, 500);

    // 3. Parameter: { sumber, tgl_awal, tgl_akhir } (rentang per tahun dikirim dari frontend)
    const body = await req.json();
    const sumber = body.sumber as Sumber;
    if (!(sumber in SUMBER)) return json({ error: "sumber tidak valid" }, 400);
    const tglAwal: string = body.tgl_awal;
    const tglAkhir: string = body.tgl_akhir;

    // 4. Ambil semua halaman sampai data habis
    let semua: Record<string, unknown>[] = [];
    for (let page = 1; page <= 200; page++) {
      const html = await ambilHalaman(sumber, tglAwal, tglAkhir, page);
      const rows = parseTabel(html);
      if (rows.length === 0) break;
      semua = semua.concat(rows);
      if (rows.length < 10) break; // jumlah baris per halaman tidak diketahui; hentikan bila sedikit
    }

    // 5. Upsert ke tabel (berdasarkan nomor_peserta), per 500 baris
    const data = tambahSumberUrl(semua, sumber);
    const table = SUMBER[sumber].table;
    for (let i = 0; i < data.length; i += 500) {
      const { error } = await admin
        .from(table)
        .upsert(data.slice(i, i + 500), { onConflict: "nomor_peserta" });
      if (error) throw new Error(error.message);
    }

    // 6. Catat log
    await admin.from("scrape_logs").insert({
      sumber, tgl_mulai: tglAwal, tgl_selesai: tglAkhir,
      jumlah: data.length, status: "sukses", oleh: user.email,
    });

    return json({ ok: true, sumber, tgl_awal: tglAwal, tgl_akhir: tglAkhir, jumlah: data.length });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
