// Carnet de tirs : lit une poule sur ffhandball.fr et renvoie ses matchs (date, heure, équipes, score).
// Appel : POST { url: "https://www.ffhandball.fr/competitions/.../poule-123456/" }
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function unesc(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
// les données de la page sont dans des balises <smartfire-component name="..." attributes="{json}">
function comps(html: string): Record<string, any> {
  const out: Record<string, any> = {};
  const re = /<smartfire-component name=['"]([^'"]+)['"] attributes="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    try { out[m[1]] = JSON.parse(unesc(m[2])); } catch (_) { /* ignore */ }
  }
  return out;
}
async function page(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "fr-FR,fr;q=0.9" } });
  if (!r.ok) throw new Error("FFHB a répondu " + r.status);
  return comps(await r.text());
}
function parseJ(p: any): number[] {
  try {
    const j = typeof p?.journees === "string" ? JSON.parse(p.journees) : (p?.journees || []);
    return j.map((x: any) => +x.journee_numero).filter((n: number) => n > 0);
  } catch (_) { return []; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const raw = String(body.url || "").trim();
    const m = raw.match(/^https?:\/\/(?:www\.)?ffhandball\.fr\/competitions\/([a-z0-9\/-]+)/i);
    if (!m) return json({ error: "Adresse non reconnue : copie l'adresse d'une compétition ou d'une poule sur ffhandball.fr." }, 400);
    let path = m[1].toLowerCase().replace(/\/+$/, "");
    const pm = path.match(/^(.*?\/poule-\d+)/);
    let first: Record<string, any>;
    let base: string;
    if (pm) {
      base = "https://www.ffhandball.fr/competitions/" + pm[1] + "/";
      first = await page(base);
    } else {
      // adresse d'une compétition : on prend la poule affichée par défaut
      first = await page("https://www.ffhandball.fr/competitions/" + path + "/");
      const any = Object.values(first).find((c: any) => c && c.ext_poule_id && c.url_competition) as any;
      if (!any) return json({ error: "Aucune poule trouvée à cette adresse. Ouvre la poule de ton équipe sur ffhandball.fr et copie son adresse." }, 404);
      base = "https://www.ffhandball.fr/competitions/saison-" + path.split("/")[0].replace(/^saison-/, "") + "/" + any.url_competition_type + "/" +
        (any.url_structure ? any.url_structure + "/" : "") + any.url_competition + "/poule-" + any.ext_poule_id + "/";
      first = await page(base);
    }
    const head = first["page-header"] || {};
    const list = first["competitions---rencontre-list"] || {};
    const poule = list.poule || first["competitions---journee-selector"]?.poule || {};
    const ps = first["competitions---poule-selector"] || {};
    const phases = new Map((ps.phases || []).map((x: any) => [String(x.id), x.libelle]));
    const poules = (ps.poules || []).map((x: any) => ({ id: String(x.ext_pouleId), name: x.libelle || "", phase: phases.get(String(x.phaseId)) || "" }));
    const js = parseJ(poule);
    const all = new Map<string, any>();
    const add = (rs: any[]) => (rs || []).forEach((r) => all.set(String(r.ext_rencontreId || r.id), r));
    add(list.rencontres);
    const sel = +(list.selected_numero_journee || 0);
    const todo = js.filter((n) => n !== sel);
    for (let i = 0; i < todo.length; i += 6) {
      const res = await Promise.all(todo.slice(i, i + 6).map((n) =>
        page(base + "journee-" + n + "/").then((c) => c["competitions---rencontre-list"]?.rencontres || []).catch(() => [])));
      res.forEach(add);
    }
    // salle de chaque match de l'équipe choisie
    const team = String(body.team || "");
    const salle = new Map<string, string>();
    if (team) {
      const mine = [...all.values()].filter((r) => String(r.equipe1Id) === team || String(r.equipe2Id) === team).slice(0, 40);
      for (let i = 0; i < mine.length; i += 6) {
        await Promise.all(mine.slice(i, i + 6).map((r) => {
          const id = String(r.ext_rencontreId || r.id);
          return page(base + "rencontre-" + id + "/").then((c) => {
            const e = c["competitions---rencontre-salle"]?.equipement;
            if (e) salle.set(id, [e.libelle, e.ville].filter(Boolean).join(", "));
          }).catch(() => {});
        }));
      }
    }
    const teams = new Map<string, string>();
    const matches = [...all.values()].map((r) => {
      teams.set(String(r.equipe1Id), r.equipe1Libelle);
      teams.set(String(r.equipe2Id), r.equipe2Libelle);
      return {
        id: String(r.ext_rencontreId || r.id), j: +r.journeeNumero || null, date: r.date || "",
        homeId: String(r.equipe1Id), home: r.equipe1Libelle || "", awayId: String(r.equipe2Id), away: r.equipe2Libelle || "",
        sh: r.equipe1Score === null || r.equipe1Score === "" ? null : r.equipe1Score,
        sa: r.equipe2Score === null || r.equipe2Score === "" ? null : r.equipe2Score,
        salle: salle.get(String(r.ext_rencontreId || r.id)) || "",
      };
    }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    return json({
      url: base, title: head.title || "", sub: head.subTitle || "", poule: poule.libelle || "", pouleId: String(poule.ext_pouleId || ""), poules,
      journees: js.length,
      teams: [...teams].filter(([id]) => id && id !== "undefined").map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      matches,
    });
  } catch (e) {
    return json({ error: "Lecture FFHB impossible : " + ((e as Error).message || e) }, 502);
  }
});
