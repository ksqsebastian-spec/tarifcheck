// Tarifcheck — Oberfläche. Kein Framework: fünf Ansichten, eine Handvoll
// JSON-Endpunkte. Farbe trägt hier Bedeutung, nicht Dekoration.

const $ = (s) => document.querySelector(s);
const inhalt = $("#inhalt");

/* ── Gewerkezeichen ─────────────────────────────────────────────────────
   Eigene Glyphen statt fremder Logos: die Quellen sind Behörden und
   Sozialkassen, deren Marken hier nichts zu suchen haben. Die Farbe ist das
   eigentliche Erkennungsmerkmal — sie zieht sich durch Übersicht, Dokument-
   und Quellenliste, sodass ein Gewerk überall dieselbe Farbe hat. */
const GEWERKE = {
  BAU: {
    name: "Bau",
    farbe: "#E8590C",
    glyph: `<rect x="3" y="5" width="8" height="5" rx="1.2"/><rect x="13" y="5" width="8" height="5" rx="1.2"/>
            <rect x="3" y="12" width="4" height="5" rx="1.2"/><rect x="9" y="12" width="8" height="5" rx="1.2"/>
            <rect x="19" y="12" width="2" height="5" rx="1"/><rect x="3" y="19" width="18" height="2.5" rx="1.2"/>`,
  },
  GERUESTBAU: {
    name: "Gerüstbau",
    farbe: "#1971C2",
    glyph: `<rect x="3" y="2" width="2.6" height="20" rx="1.3"/><rect x="18.4" y="2" width="2.6" height="20" rx="1.3"/>
            <rect x="10.7" y="2" width="2.6" height="20" rx="1.3"/>
            <rect x="3" y="6.5" width="18" height="2.4" rx="1.2"/><rect x="3" y="15.1" width="18" height="2.4" rx="1.2"/>`,
  },
  MALER: {
    name: "Maler",
    farbe: "#9C36B5",
    glyph: `<rect x="3" y="3" width="15" height="6.5" rx="2"/><rect x="18" y="5" width="3.4" height="2.5" rx="1.2"/>
            <rect x="9.4" y="9.5" width="2.4" height="4" rx="1.2"/>
            <rect x="7" y="13" width="7.2" height="8.6" rx="2.2"/>`,
  },
  TISCHLER: {
    name: "Tischler",
    farbe: "#B25E1E",
    glyph: `<rect x="2.5" y="4" width="19" height="5" rx="1.6"/>
            <path d="M2.5 13h19l-2.4 3.4-2.4-3.4-2.4 3.4L11.9 13l-2.4 3.4L7.1 13l-2.4 3.4z"/>
            <rect x="2.5" y="19" width="19" height="2.6" rx="1.3"/>`,
  },
  UEBERGREIFEND: {
    name: "Übergreifend",
    farbe: "#1F7A5C",
    glyph: `<rect x="3" y="4" width="18" height="3.4" rx="1.7"/><rect x="3" y="10.3" width="18" height="3.4" rx="1.7"/>
            <rect x="3" y="16.6" width="10" height="3.4" rx="1.7"/>`,
  },
};

const gw = (k) => GEWERKE[k] ?? { name: k, farbe: "#6e6e78", glyph: `<circle cx="12" cy="12" r="7"/>` };

function marke(gewerk, klasse = "marke") {
  const g = gw(gewerk);
  return `<span class="${klasse}" style="background:${g.farbe}1f">
    <svg viewBox="0 0 24 24" fill="${g.farbe}" aria-hidden="true">${g.glyph}</svg></span>`;
}

const ZUSTAND = { aktuell: "Aktuell", handlungsbedarf: "Handlungsbedarf", fehler: "Abruf fehlgeschlagen" };

/* ── Kleinkram ──────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const mitLinks = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g,
  (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

const datum = (iso) => iso
  ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })
  : "—";
const datumZeit = (iso) => iso
  ? new Date(iso).toLocaleString("de-DE",
      { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—";

async function hole(pfad, optionen) {
  const antwort = await fetch(pfad, optionen);
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) throw new Error(daten.fehler || `Fehler ${antwort.status}`);
  return daten;
}

let leisteTimer;
function melden(text, art = "") {
  const l = $("#leiste");
  l.textContent = text;
  l.className = art;
  l.hidden = false;
  clearTimeout(leisteTimer);
  // Auch Fehler verschwinden wieder. Eine Leiste, die stehen bleibt, wird
  // nach dem zweiten Blick zur Tapete und verdeckt trotzdem den Inhalt.
  leisteTimer = setTimeout(() => (l.hidden = true), art === "schlecht" ? 12000 : 6000);
}

/* Was die Seite anbieten darf. Wird einmal beim Start geholt.
   Solange Access nicht eingerichtet ist, sind schreibende Zugriffe gesperrt —
   dann werden die entsprechenden Knöpfe gar nicht erst gezeigt, statt sie
   anzubieten und beim Druck mit einem Fehler zu antworten. */
let darf = { schreiben: false, anmeldung_eingerichtet: false, angemeldet: null };

const gesperrtHinweis = () => darf.schreiben ? "" : `
  <div class="notiz rise" style="margin-bottom:18px">
    <b>Nur Lesezugriff.</b> ${darf.anmeldung_eingerichtet
      ? `Zum Hochladen, Quellen ändern und Prüfen bitte oben rechts anmelden.`
      : "Die Anmeldung ist auf diesem Server noch nicht eingerichtet — siehe SETUP.md."}
    Der tägliche Abruf um 06:15 läuft davon unberührt weiter.
  </div>`;

/* ── Ansichten ──────────────────────────────────────────────────────────── */
let aktuell = "uebersicht";
let filter = null;

async function zeige(name) {
  aktuell = name;
  document.querySelectorAll("nav button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.dataset.ansicht === name)));
  inhalt.innerHTML = `<p class="leer">Wird geladen …</p>`;
  try {
    await { uebersicht, meldungen, dokumente, quellen, hochladen,
            anmelden: () => anmeldemaske() }[name]();
  } catch (e) {
    inhalt.innerHTML = `<div class="karte"><p class="leer" style="padding:0">
      Konnte nicht geladen werden: ${esc(e.message)}</p></div>`;
  }
}

async function uebersicht() {
  const d = await hole("/api/uebersicht");
  zaehlerSetzen(d.ungelesen);

  if (!d.gewerke.length) {
    inhalt.innerHTML = `<div class="karte"><p class="leer" style="padding:0">
      Noch keine Quellen eingespielt — siehe SETUP.md.</p></div>`;
    return;
  }

  inhalt.innerHTML = `
    ${gesperrtHinweis()}
    <div class="abschnitt rise"><h2>Stand je Gewerk</h2><span class="fuellung"></span>
      <span class="meta">${d.gewerke.reduce((n, g) => n + g.dokumente, 0)} Dokumente</span></div>
    <div class="gitter">
      ${d.gewerke.map((g, i) => `
        <button class="gewerk rise d${Math.min(6, i + 1)}" data-gewerk="${esc(g.gewerk)}">
          <div class="kopf">${marke(g.gewerk)}
            <div><h3>${esc(gw(g.gewerk).name)}</h3>
              <div class="zahl">${g.dokumente} Dokument${g.dokumente === 1 ? "" : "e"}</div></div>
          </div>
          <div class="fuss">
            <span class="ampel ${g.status}"></span>
            <span class="zustand ${g.status}">${ZUSTAND[g.status]}</span>
          </div>
          <div class="gepruef">Geprüft ${datum(g.letzte_pruefung)}</div>
        </button>`).join("")}
    </div>
    <div class="notiz rise d6" style="margin-top:20px">
      Für <b>Tischler</b> und den <b>Lohn-TV Gerüstbau</b> gibt es keine öffentliche
      Volltextquelle — dort wird nur die Downloadseite überwacht. Meldet sie eine Änderung,
      muss das Dokument einmal von Hand hochgeladen werden.
    </div>`;

  inhalt.querySelectorAll(".gewerk").forEach((k) =>
    k.addEventListener("click", () => { filter = k.dataset.gewerk; zeige("dokumente"); }));
}

async function meldungen() {
  const d = await hole("/api/meldungen");
  const offen = d.meldungen.filter((m) => !m.gelesen).length;
  zaehlerSetzen(offen);

  if (!d.meldungen.length) {
    inhalt.innerHTML = `<div class="karte"><p class="leer" style="padding:0">
      Nichts Neues. Hier erscheinen Änderungen, Fehler und Uploads.</p></div>`;
    return;
  }

  inhalt.innerHTML = `
    <div class="abschnitt rise"><h2>Benachrichtigungen</h2><span class="fuellung"></span>
      ${offen && darf.schreiben
        ? `<button id="alle" class="knopf-rand">Alle als gelesen markieren</button>` : ""}</div>
    ${d.meldungen.map((m, i) => `
      <div class="meldung art-${esc(m.art)} ${m.gelesen ? "gelesen" : ""} rise d${Math.min(6, (i % 6) + 1)}">
        <h3>${esc(m.titel)}</h3>
        <div class="zeile">
          <span>${datumZeit(m.zeitpunkt)}</span>
          ${m.gewerk ? `<span class="trenner">·</span><span>${esc(gw(m.gewerk).name)}</span>` : ""}
          ${m.gelesen || !darf.schreiben ? "" : `<span class="trenner">·</span>
            <button class="knopf-klein gelesen" data-id="${m.id}">als gelesen markieren</button>`}
        </div>
        ${m.beschreibung ? `<p class="rumpf">${mitLinks(m.beschreibung)}</p>` : ""}
      </div>`).join("")}`;

  $("#alle")?.addEventListener("click", () => gelesen({ alle: true }));
  inhalt.querySelectorAll(".gelesen").forEach((b) =>
    b.addEventListener("click", () => gelesen({ ids: [Number(b.dataset.id)] })));
}

async function gelesen(koerper) {
  try {
    await hole("/api/meldungen/gelesen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(koerper),
    });
    zeige("meldungen");
  } catch (e) { melden(e.message, "schlecht"); }
}

async function dokumente() {
  const d = await hole(filter ? `/api/dokumente?gewerk=${encodeURIComponent(filter)}` : "/api/dokumente");

  inhalt.innerHTML = `
    <div class="abschnitt rise">
      <h2>Dokumente${filter ? " · " + esc(gw(filter).name) : ""}</h2>
      <span class="fuellung"></span>
      ${filter ? `<button id="alleG" class="knopf-rand">Alle Gewerke</button>` : ""}
    </div>
    <div class="karte rise d1" style="padding:4px 26px 6px">
      <div class="zeilen" style="border-top:0">
        ${d.dokumente.map((x) => zeileDokument(x)).join("") ||
          `<p class="leer">Keine Dokumente.</p>`}
      </div>
    </div>
    <p class="meta rise d2" style="margin-top:14px">
      Die Texte liegen für den MCP bereit, nicht zum Herunterladen. „Quelle" führt zum
      Herausgeber.
    </p>`;

  $("#alleG")?.addEventListener("click", () => { filter = null; zeige("dokumente"); });
}

function zeileDokument(x) {
  const ohneText = x.aktuelle_version_id && x.text_brauchbar === 0;
  const fahnen = [
    x.herkunft === "manuell" ? `<span class="fahne">hochgeladen</span>` : "",
    x.quelle_typ === "watch" ? `<span class="fahne">beobachtete Seite</span>` : "",
    ohneText ? `<span class="fahne rot">kein Text gewinnbar</span>` : "",
    x.letzter_status === "fehler" ? `<span class="fahne rot">Abruf gescheitert</span>` : "",
    !x.aktuelle_version_id ? `<span class="fahne warn">noch kein Inhalt</span>` : "",
  ].filter(Boolean).join("");

  return `<div class="dok">
    ${marke(x.gewerk)}
    <div class="haupt">
      <div class="titel">${esc(x.titel)}</div>
      <div class="unter">
        <span>${esc(gw(x.gewerk).name)}</span>
        ${x.gueltig_ab ? `<span class="trenner">·</span><span>gültig ab ${datum(x.gueltig_ab)}</span>` : ""}
        ${x.quelle_url ? `<span class="trenner">·</span>
          <a href="${esc(x.quelle_url)}" target="_blank" rel="noopener"
             style="text-decoration:underline;text-underline-offset:2px">Quelle</a>` : ""}
      </div>
      ${fahnen ? `<div class="unter" style="margin-top:7px">${fahnen}</div>` : ""}
    </div>
    <div class="rechts">${x.aktuelle_version_id ? datum(x.stand) : "—"}</div>
  </div>`;
}

async function quellen() {
  const d = await hole("/api/quellen");

  inhalt.innerHTML = `
    ${gesperrtHinweis()}
    <div class="abschnitt rise"><h2>Quellen</h2></div>
    <div class="notiz rise d1" style="margin-bottom:16px">
      Baut ein Herausgeber seine Seite um, geht der Link ins Leere und der Abruf meldet
      einen Fehler. Dann hier die Adresse korrigieren.
    </div>
    <div class="karte rise d2" style="padding:4px 26px 6px">
      <div class="zeilen" style="border-top:0">
        ${d.quellen.map((q) => `
          <div class="dok">
            ${marke(q.gewerk)}
            <div class="haupt">
              <div class="titel">${esc(q.kuerzel)}
                <span class="fahne" style="margin-left:6px">${q.typ === "watch" ? "beobachtet" : "Download"}</span></div>
              <div class="unter"><span>${esc(gw(q.gewerk).name)}</span>
                <span class="trenner">·</span><span>${esc(q.firmen)}</span></div>
              ${q.letzter_fehler ? `<div class="unter" style="margin-top:7px">
                <span class="fahne rot">${esc(q.letzter_fehler.slice(0, 90))}</span></div>` : ""}
              <div style="display:flex;gap:8px;margin-top:10px">
                <input class="feld" type="url" value="${esc(q.url)}" data-q="${esc(q.id)}"
                       style="font-size:13px;padding:8px 11px" ${darf.schreiben ? "" : "readonly"}>
                ${darf.schreiben
                  ? `<button class="knopf-rand sichern" data-q="${esc(q.id)}">Sichern</button>` : ""}
              </div>
            </div>
          </div>`).join("")}
      </div>
    </div>`;

  inhalt.querySelectorAll(".sichern").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.q;
      const feld = inhalt.querySelector(`input[data-q="${CSS.escape(id)}"]`);
      b.disabled = true;
      try {
        await hole(`/api/quellen/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: feld.value }),
        });
        melden(`Adresse für ${id} gespeichert.`, "gut");
      } catch (e) { melden(e.message, "schlecht"); }
      finally { b.disabled = false; }
    }));
}

async function hochladen() {
  if (!darf.schreiben) {
    inhalt.innerHTML = `
      <div class="abschnitt rise"><h2>Dokument hochladen</h2></div>
      ${gesperrtHinweis()}
      <div class="karte rise d1">
        <p class="meta" style="max-width:56ch;margin-bottom:16px">
          Hier lädst du Verträge hoch, für die es keine öffentliche Quelle gibt —
          Tischlerhandwerk und den Lohn-Tarifvertrag Gerüstbau.
        </p>
        ${darf.anmeldung_eingerichtet
          ? `<button class="knopf" id="jetzt-anmelden">Anmelden</button>`
          : `<p class="meta">Die Anmeldung ist auf diesem Server noch nicht eingerichtet
             — siehe <b>SETUP.md</b>.</p>`}
      </div>`;
    $("#jetzt-anmelden")?.addEventListener("click", () => anmeldemaske("hochladen"));
    return;
  }
  inhalt.innerHTML = `
    <div class="abschnitt rise"><h2>Dokument hochladen</h2></div>
    <div class="karte rise d1">
      <p class="meta" style="margin-bottom:18px;max-width:56ch">
        Für alles, was es nicht frei im Netz gibt — Tischlerhandwerk und den Lohn-Tarifvertrag
        Gerüstbau. Die Datei wird genauso in Text überführt wie die automatisch geholten und
        steht danach gleichwertig zur Verfügung.
      </p>
      <form id="up">
        <label>Datei
          <input class="feld" type="file" name="datei" required
                 accept=".pdf,.docx,.doc,.html,.htm,.txt,.md,.png,.jpg,.jpeg"></label>
        <label>Gewerk
          <select class="feld" name="gewerk" required>
            <option value="">— bitte wählen —</option>
            ${Object.entries(GEWERKE).map(([k, v]) =>
              `<option value="${k}">${v.name}</option>`).join("")}
          </select></label>
        <label>Titel
          <input class="feld" type="text" name="titel" required
                 placeholder="z. B. Manteltarifvertrag Tischlerhandwerk Nord"></label>
        <label>Gültig ab <span class="freiwillig">— freiwillig, aber hilfreich</span>
          <input class="feld" type="date" name="gueltig_ab"></label>
        <button type="submit" class="knopf" style="justify-self:start">Hochladen</button>
      </form>
      <p class="meta" style="margin-top:18px;font-size:.86rem;max-width:56ch">
        Das Gültigkeitsdatum wird bewusst nicht aus dem Dokument geraten. Was hier steht,
        gibt der MCP später mit aus — lieber leer als falsch.
      </p>
    </div>`;

  $("#up").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const knopf = form.querySelector("button");
    knopf.disabled = true;
    knopf.textContent = "Wird verarbeitet …";
    try {
      const antwort = await fetch("/api/upload", { method: "POST", body: new FormData(form) });
      const daten = await antwort.json();
      if (!antwort.ok) throw new Error(daten.fehler || `Fehler ${antwort.status}`);
      melden(daten.warnung
        ? `Hochgeladen — aber: ${daten.warnung}`
        : "Hochgeladen und durchsuchbar gemacht.", daten.warnung ? "schlecht" : "gut");
      form.reset();
    } catch (err) { melden(err.message, "schlecht"); }
    finally { knopf.disabled = false; knopf.textContent = "Hochladen"; }
  });
}

function anmeldemaske(zurueck = "uebersicht") {
  inhalt.innerHTML = `
    <div class="abschnitt rise"><h2>Anmelden</h2></div>
    <div class="karte rise d1" style="max-width:440px">
      <p class="meta" style="margin-bottom:18px">
        Ein gemeinsames Konto für alle, die Verträge hochladen oder Quellen pflegen.
        Lesen geht auch ohne.
      </p>
      <form id="login">
        <label>Benutzername
          <input class="feld" name="benutzer" autocomplete="username" required autofocus></label>
        <label>Passwort
          <input class="feld" type="password" name="passwort" autocomplete="current-password" required></label>
        <button class="knopf" type="submit" style="justify-self:start">Anmelden</button>
      </form>
    </div>`;

  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const knopf = form.querySelector("button");
    knopf.disabled = true;
    try {
      const d = new FormData(form);
      await hole("/api/anmelden", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ benutzer: d.get("benutzer"), passwort: d.get("passwort") }),
      });
      darf = await hole("/api/status");
      knoepfeSetzen();
      melden("Angemeldet.", "gut");
      zeige(zurueck);
    } catch (err) {
      melden(err.message, "schlecht");
      knopf.disabled = false;
    }
  });
}

function knoepfeSetzen() {
  $("#pruefen").hidden = !darf.schreiben;
  $("#abmelden").hidden = !darf.schreiben;
  $("#anmelden").hidden = darf.schreiben || !darf.anmeldung_eingerichtet;
  const w = $("#wer");
  w.textContent = darf.angemeldet ?? "";
  w.hidden = !darf.angemeldet;
}

function zaehlerSetzen(n) {
  const z = $("#zaehler");
  z.textContent = n;
  z.hidden = !n;
}

/* ── Verdrahtung ────────────────────────────────────────────────────────── */
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.ansicht === "dokumente" && aktuell !== "dokumente") filter = null;
    zeige(b.dataset.ansicht);
  }));

$("#anmelden").addEventListener("click", () => anmeldemaske(aktuell === "anmelden" ? "uebersicht" : aktuell));

$("#abmelden").addEventListener("click", async () => {
  await fetch("/api/abmelden", { method: "POST" }).catch(() => {});
  darf = await hole("/api/status").catch(() => darf);
  knoepfeSetzen();
  melden("Abgemeldet.", "gut");
  zeige("uebersicht");
});

$("#pruefen").addEventListener("click", async (e) => {
  const k = e.currentTarget;
  k.disabled = true;
  k.textContent = "Läuft …";
  melden("Alle Quellen werden abgerufen. Das dauert einen Moment.");
  try {
    const { ergebnisse } = await hole("/api/sync", { method: "POST" });
    const neu = ergebnisse.filter((r) => r.status === "ok").length;
    const kaputt = ergebnisse.filter((r) => r.status === "fehler").length;
    melden(`${ergebnisse.length} Quellen geprüft — ${neu} mit Änderung, ${kaputt} fehlgeschlagen.`,
      kaputt ? "schlecht" : "gut");
    zeige(aktuell);
  } catch (err) { melden(err.message, "schlecht"); }
  finally { k.disabled = false; k.textContent = "Jetzt prüfen"; }
});

(function kopfSchatten() {
  const h = document.querySelector("header");
  const f = () => h.classList.toggle("stuck", window.scrollY > 6);
  f();
  window.addEventListener("scroll", f, { passive: true });
})();

(async function start() {
  try { darf = await hole("/api/status"); } catch { /* Standard bleibt: nur lesen */ }
  knoepfeSetzen();
  hole("/api/uebersicht").then((d) => zaehlerSetzen(d.ungelesen)).catch(() => {});
  zeige("uebersicht");
})();
