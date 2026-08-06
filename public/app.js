// Tarifcheck — Oberfläche. Kein Framework: die Seite hat fünf Ansichten und
// spricht mit einer Handvoll JSON-Endpunkten.

const $ = (s) => document.querySelector(s);
const GEWERK_NAME = {
  BAU: "Bau", GERUESTBAU: "Gerüstbau", MALER: "Maler",
  TISCHLER: "Tischler", UEBERGREIFEND: "Übergreifend",
};
const STATUS_TEXT = {
  aktuell: "Aktuell", handlungsbedarf: "Handlungsbedarf", fehler: "Abruf fehlgeschlagen",
};

const zeigeGewerk = (g) => GEWERK_NAME[g] ?? g;

function datum(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function datumZeit(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Text aus Meldungen: escapen, dann nackte Links klickbar machen. */
function textMitLinks(s) {
  return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) =>
    `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

async function hole(pfad, optionen) {
  const antwort = await fetch(pfad, optionen);
  const daten = await antwort.json().catch(() => ({}));
  if (!antwort.ok) throw new Error(daten.fehler || `Fehler ${antwort.status}`);
  return daten;
}

let hinweisTimer;
function hinweis(text, art = "") {
  const leiste = $("#hinweisleiste");
  leiste.textContent = text;
  leiste.className = art;
  leiste.hidden = false;
  clearTimeout(hinweisTimer);
  if (art !== "schlecht") hinweisTimer = setTimeout(() => (leiste.hidden = true), 6000);
}

// ——— Ansichten ———————————————————————————————————————————————

let aktuelleAnsicht = "uebersicht";
let dokumentFilter = null;

function wechsle(name) {
  aktuelleAnsicht = name;
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("aktiv", b.dataset.ansicht === name));
  document.querySelectorAll(".ansicht").forEach((s) =>
    (s.hidden = s.id !== `ansicht-${name}`));
  if (name !== "hochladen") laden(name);
}

async function laden(name) {
  const ziel = $(`#ansicht-${name}`);
  ziel.innerHTML = '<p class="leer">Wird geladen …</p>';
  try {
    if (name === "uebersicht") await zeigeUebersicht(ziel);
    if (name === "meldungen") await zeigeMeldungen(ziel);
    if (name === "dokumente") await zeigeDokumente(ziel);
    if (name === "quellen") await zeigeQuellen(ziel);
  } catch (e) {
    ziel.innerHTML = `<div class="karte"><p class="leer">Konnte nicht geladen werden: ${esc(e.message)}</p></div>`;
  }
}

async function zeigeUebersicht(ziel) {
  const daten = await hole("/api/uebersicht");
  ungelesenSetzen(daten.ungelesen);

  if (!daten.gewerke.length) {
    ziel.innerHTML = `<div class="karte"><p class="leer">
      Noch keine Quellen eingespielt. Siehe SETUP.md, Schritt „Quellen einspielen".</p></div>`;
    return;
  }

  const karten = daten.gewerke.map((g) => `
    <div class="gewerk ${g.status}" data-gewerk="${esc(g.gewerk)}" role="button" tabindex="0">
      <div class="name">${esc(zeigeGewerk(g.gewerk))}</div>
      <div class="status ${g.status}">${STATUS_TEXT[g.status]}</div>
      <div class="zeile">${g.dokumente} Dokument${g.dokumente === 1 ? "" : "e"}</div>
      <div class="zeile">Zuletzt geprüft: ${datum(g.letzte_pruefung)}</div>
      ${Number(g.ohne_inhalt) > 0
        ? `<div class="warnung">${g.ohne_inhalt} noch ohne Inhalt</div>` : ""}
    </div>`).join("");

  ziel.innerHTML = `
    <div class="kopfreihe"><h2>Stand je Gewerk</h2></div>
    <div class="gewerke">${karten}</div>
    <div class="karte" style="margin-top:14px">
      <p class="erklaerung" style="margin:0">
        Für <strong>Tischler</strong> und den <strong>Lohn-TV Gerüstbau</strong> gibt es keine
        öffentliche Volltextquelle — dort wird nur die Downloadseite überwacht. Meldet sie eine
        Änderung, muss das Dokument einmal von Hand hochgeladen werden.
      </p>
    </div>`;

  ziel.querySelectorAll(".gewerk").forEach((k) => {
    const oeffnen = () => { dokumentFilter = k.dataset.gewerk; wechsle("dokumente"); };
    k.addEventListener("click", oeffnen);
    k.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") oeffnen(); });
  });
}

async function zeigeMeldungen(ziel) {
  const daten = await hole("/api/meldungen");
  const ungelesen = daten.meldungen.filter((m) => !m.gelesen).length;
  ungelesenSetzen(ungelesen);

  if (!daten.meldungen.length) {
    ziel.innerHTML = `<div class="karte"><p class="leer">
      Noch nichts passiert. Hier erscheinen Änderungen, Fehler und Uploads.</p></div>`;
    return;
  }

  ziel.innerHTML = `
    <div class="kopfreihe">
      <h2>Benachrichtigungen</h2>
      ${ungelesen ? '<button id="alle-gelesen" class="knopf-still">Alle als gelesen markieren</button>' : ""}
    </div>
    ${daten.meldungen.map((m) => `
      <div class="meldung ${m.gelesen ? "gelesen" : "ungelesen"} art-${esc(m.art)}">
        <h3>${esc(m.titel)}</h3>
        <div class="meta">
          ${datumZeit(m.zeitpunkt)}${m.gewerk ? " · " + esc(zeigeGewerk(m.gewerk)) : ""}
          ${m.gelesen ? "" : ' · <button class="knopf-still gelesen-knopf" data-id="' + m.id + '">als gelesen markieren</button>'}
        </div>
        ${m.beschreibung ? `<p class="rumpf">${textMitLinks(m.beschreibung)}</p>` : ""}
      </div>`).join("")}`;

  $("#alle-gelesen")?.addEventListener("click", async () => {
    await hole("/api/meldungen/gelesen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alle: true }),
    });
    laden("meldungen");
  });

  ziel.querySelectorAll(".gelesen-knopf").forEach((b) =>
    b.addEventListener("click", async () => {
      await hole("/api/meldungen/gelesen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [Number(b.dataset.id)] }),
      });
      laden("meldungen");
    }));
}

async function zeigeDokumente(ziel) {
  const pfad = dokumentFilter
    ? `/api/dokumente?gewerk=${encodeURIComponent(dokumentFilter)}`
    : "/api/dokumente";
  const daten = await hole(pfad);

  const zeilen = daten.dokumente.map((d) => {
    const punkt = d.letzter_status ?? "keiner";
    return `
      <tr>
        <td>
          <span class="punkt ${punkt}"></span><strong>${esc(d.titel)}</strong>
          ${d.herkunft === "manuell" ? ' <span class="freiwillig">(hochgeladen)</span>' : ""}
          ${d.aktuelle_version_id && d.text_brauchbar === 0
            ? `<div class="warnung" style="color:var(--rot);border-color:var(--rot)">Kein Text gewinnbar — Datei liegt vor, ist aber nicht durchsuchbar</div>` : ""}
          ${d.hinweis ? `<div class="warnung">${esc(d.hinweis)}</div>` : ""}
          ${d.letzter_fehler ? `<div class="warnung" style="color:var(--rot);border-color:var(--rot)">${esc(d.letzter_fehler)}</div>` : ""}
        </td>
        <td class="leise">${esc(zeigeGewerk(d.gewerk))}</td>
        <td class="leise">${d.aktuelle_version_id ? datum(d.stand) : "— noch kein Inhalt —"}</td>
        <td class="leise">${d.gueltig_ab ? datum(d.gueltig_ab) : "—"}</td>
        <td class="leise">${d.quelle_url
          ? `<a href="${esc(d.quelle_url)}" target="_blank" rel="noopener">Quelle</a>` : "—"}</td>
      </tr>`;
  }).join("");

  ziel.innerHTML = `
    <div class="kopfreihe">
      <h2>Dokumente${dokumentFilter ? " — " + esc(zeigeGewerk(dokumentFilter)) : ""}</h2>
      ${dokumentFilter ? '<button id="filter-weg" class="knopf-still">Alle Gewerke</button>' : ""}
    </div>
    <div class="karte">
      <div class="tabelle-huelle">
        <table>
          <thead><tr>
            <th>Dokument</th><th>Gewerk</th><th>Stand</th><th>Gültig ab</th><th>Original</th>
          </tr></thead>
          <tbody>${zeilen || '<tr><td colspan="5" class="leer">Keine Dokumente.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="erklaerung klein">
        Die Texte werden hier nicht zum Download angeboten — sie liegen für den MCP bereit.
        „Original" führt zur Quelle beim Herausgeber.
      </p>
    </div>`;

  $("#filter-weg")?.addEventListener("click", () => { dokumentFilter = null; laden("dokumente"); });
}

async function zeigeQuellen(ziel) {
  const daten = await hole("/api/quellen");

  const zeilen = daten.quellen.map((q) => `
    <tr>
      <td>
        <span class="punkt ${q.letzter_status ?? "keiner"}"></span><strong>${esc(q.kuerzel)}</strong>
        <div class="leise" style="font-size:12px">${esc(zeigeGewerk(q.gewerk))} · ${esc(q.firmen)}</div>
        ${q.letzter_fehler
          ? `<div class="warnung" style="color:var(--rot);border-color:var(--rot)">${esc(q.letzter_fehler)}</div>`
          : ""}
      </td>
      <td class="leise">${q.typ === "watch" ? "beobachtet" : "Download"}</td>
      <td>
        <input type="url" value="${esc(q.url)}" data-quelle="${esc(q.id)}"
               style="width:100%;min-width:240px;font-size:12px">
      </td>
      <td>
        <button class="knopf-still speichern" data-quelle="${esc(q.id)}">Speichern</button>
      </td>
    </tr>`).join("");

  ziel.innerHTML = `
    <div class="kopfreihe"><h2>Quellen</h2></div>
    <div class="karte">
      <p class="erklaerung">
        Baut ein Herausgeber seine Seite um, geht der Link ins Leere und der Abruf meldet
        einen Fehler. Dann hier die Adresse korrigieren.
      </p>
      <div class="tabelle-huelle">
        <table>
          <thead><tr><th>Kürzel</th><th>Art</th><th>Adresse</th><th></th></tr></thead>
          <tbody>${zeilen}</tbody>
        </table>
      </div>
    </div>`;

  ziel.querySelectorAll(".speichern").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.quelle;
      const feld = ziel.querySelector(`input[data-quelle="${CSS.escape(id)}"]`);
      b.disabled = true;
      try {
        await hole(`/api/quellen/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: feld.value }),
        });
        hinweis(`Adresse für ${id} gespeichert.`, "gut");
      } catch (e) {
        hinweis(e.message, "schlecht");
      } finally {
        b.disabled = false;
      }
    }));
}

function ungelesenSetzen(anzahl) {
  const p = $("#ungelesen-zahl");
  p.textContent = anzahl;
  p.hidden = !anzahl;
}

// ——— Verdrahtung ————————————————————————————————————————————

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.ansicht === "dokumente" && aktuelleAnsicht !== "dokumente") {
      dokumentFilter = null;
    }
    wechsle(b.dataset.ansicht);
  }));

$("#jetzt-pruefen").addEventListener("click", async (e) => {
  const knopf = e.currentTarget;
  knopf.disabled = true;
  knopf.textContent = "Läuft …";
  hinweis("Alle Quellen werden abgerufen. Das dauert einen Moment.");
  try {
    const { ergebnisse } = await hole("/api/sync", { method: "POST" });
    const geaendert = ergebnisse.filter((r) => r.status === "ok").length;
    const kaputt = ergebnisse.filter((r) => r.status === "fehler").length;
    hinweis(
      `${ergebnisse.length} Quellen geprüft — ${geaendert} mit Änderung, ` +
      `${kaputt} fehlgeschlagen.`,
      kaputt ? "schlecht" : "gut",
    );
    laden(aktuelleAnsicht);
  } catch (err) {
    hinweis(err.message, "schlecht");
  } finally {
    knopf.disabled = false;
    knopf.textContent = "Jetzt prüfen";
  }
});

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const knopf = form.querySelector("button");
  knopf.disabled = true;
  knopf.textContent = "Wird umgewandelt …";
  try {
    const antwort = await fetch("/api/upload", { method: "POST", body: new FormData(form) });
    const daten = await antwort.json();
    if (!antwort.ok) throw new Error(daten.fehler || `Fehler ${antwort.status}`);
    hinweis("Hochgeladen und in Text umgewandelt. Es steht jetzt zur Verfügung.", "gut");
    form.reset();
  } catch (err) {
    hinweis(err.message, "schlecht");
  } finally {
    knopf.disabled = false;
    knopf.textContent = "Hochladen";
  }
});

// Ungelesen-Zähler stimmt auch, wenn man auf einer anderen Ansicht startet.
hole("/api/uebersicht").then((d) => ungelesenSetzen(d.ungelesen)).catch(() => {});
wechsle("uebersicht");
