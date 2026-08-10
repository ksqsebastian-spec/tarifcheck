-- Riegel statt Zusagen.
--
-- Bisher standen die Regeln dieses Systems an drei Stellen: in der API, im
-- Prompt der Pflegeroutine und als Kommentar im Schema ("Nichts wird
-- ueberschrieben, nichts geloescht"). Alle drei sind Absichtserklaerungen.
-- Wer an der Datenbank vorbei an die Tabellen kommt - die woechentliche
-- Routine tut das inzwischen - haelt sich daran, weil man es ihm gesagt hat.
--
-- Hier stehen dieselben Regeln als Trigger. Ein Trigger diskutiert nicht.
--
-- Bewusst Trigger und nicht CHECK: CHECK liesse sich in SQLite nur durch einen
-- Tabellenneubau nachruesten (Kopie anlegen, Daten umschaufeln, umbenennen),
-- und Trigger koennen zusaetzlich das, was CHECK grundsaetzlich nicht kann -
-- ein DELETE verhindern.

/* ── Quellenadressen ──────────────────────────────────────────────────────

   GLOB und nicht LIKE: LIKE vergleicht in SQLite ohne Ruecksicht auf Gross-
   und Kleinschreibung, "HTTPS://" kaeme also durch. GLOB ist genau.          */

CREATE TRIGGER quellen_url_https_neu BEFORE INSERT ON quellen
WHEN NEW.url NOT GLOB 'https://*'
BEGIN
  SELECT RAISE(ABORT, 'Quellenadresse muss mit https:// beginnen');
END;

CREATE TRIGGER quellen_url_https_aendern BEFORE UPDATE OF url ON quellen
WHEN NEW.url NOT GLOB 'https://*'
BEGIN
  SELECT RAISE(ABORT, 'Quellenadresse muss mit https:// beginnen');
END;

/* ── Gewerke ──────────────────────────────────────────────────────────────

   Ein Tippfehler beim Hochladen ("BAUU") legte bisher ein Dokument an, das
   die Oberflaeche grau und namenlos zeichnet und das der MCP bei jeder nach
   Gewerk gefilterten Abfrage uebergeht. Vorhanden, aber halb unsichtbar -
   die unangenehmste Sorte Fehler.                                            */

CREATE TRIGGER dokumente_gewerk_neu BEFORE INSERT ON dokumente
WHEN NEW.gewerk NOT IN ('BAU', 'GERUESTBAU', 'MALER', 'TISCHLER', 'UEBERGREIFEND')
BEGIN
  SELECT RAISE(ABORT, 'Unbekanntes Gewerk. Erlaubt: BAU, GERUESTBAU, MALER, TISCHLER, UEBERGREIFEND');
END;

CREATE TRIGGER dokumente_gewerk_aendern BEFORE UPDATE OF gewerk ON dokumente
WHEN NEW.gewerk NOT IN ('BAU', 'GERUESTBAU', 'MALER', 'TISCHLER', 'UEBERGREIFEND')
BEGIN
  SELECT RAISE(ABORT, 'Unbekanntes Gewerk. Erlaubt: BAU, GERUESTBAU, MALER, TISCHLER, UEBERGREIFEND');
END;

CREATE TRIGGER quellen_gewerk_neu BEFORE INSERT ON quellen
WHEN NEW.gewerk NOT IN ('BAU', 'GERUESTBAU', 'MALER', 'TISCHLER', 'UEBERGREIFEND')
BEGIN
  SELECT RAISE(ABORT, 'Unbekanntes Gewerk. Erlaubt: BAU, GERUESTBAU, MALER, TISCHLER, UEBERGREIFEND');
END;

/* ── Gueltigkeitsdatum ────────────────────────────────────────────────────

   Der PATCH-Endpunkt prueft das Format seit jeher, der Upload nicht. Ein
   Datum in falscher Form ist schlimmer als keins: es sieht aus wie eine
   gepflegte Angabe und sortiert doch falsch.                                 */

CREATE TRIGGER dokumente_datum_neu BEFORE INSERT ON dokumente
WHEN NEW.gueltig_ab IS NOT NULL
 AND NEW.gueltig_ab NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'gueltig_ab bitte als JJJJ-MM-TT');
END;

CREATE TRIGGER dokumente_datum_aendern BEFORE UPDATE OF gueltig_ab ON dokumente
WHEN NEW.gueltig_ab IS NOT NULL
 AND NEW.gueltig_ab NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
BEGIN
  SELECT RAISE(ABORT, 'gueltig_ab bitte als JJJJ-MM-TT');
END;

/* ── aktiv ist ein Ja oder ein Nein ───────────────────────────────────── */

CREATE TRIGGER quellen_aktiv_neu BEFORE INSERT ON quellen
WHEN NEW.aktiv NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'aktiv ist 0 oder 1');
END;

CREATE TRIGGER quellen_aktiv_aendern BEFORE UPDATE OF aktiv ON quellen
WHEN NEW.aktiv NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'aktiv ist 0 oder 1');
END;

/* ── Das Archiv bleibt ────────────────────────────────────────────────────

   Der Zweck dieser Datenbank ist, dass man spaeter noch nachsehen kann, was
   im Mai galt. Eine geloeschte Fassung ist nicht wiederherstellbar - die
   Bytes in R2 gehoeren dann niemandem mehr.

   Quellen werden stillgelegt (aktiv = 0), nicht geloescht: an ihnen haengen
   Dokumente und deren ganze Geschichte.

   Dokumente duerfen weg, solange keine Fassung an ihnen haengt. Das ist kein
   Schlupfloch, sondern genau der Fall, den der Upload braucht: schlaegt die
   Textumwandlung fehl, nimmt er das eben angelegte Dokument zurueck.          */

CREATE TRIGGER versionen_kein_loeschen BEFORE DELETE ON versionen
BEGIN
  SELECT RAISE(ABORT, 'Fassungen werden nicht geloescht — das Archiv ist der Zweck des Systems');
END;

CREATE TRIGGER quellen_kein_loeschen BEFORE DELETE ON quellen
BEGIN
  SELECT RAISE(ABORT, 'Quellen werden stillgelegt (aktiv = 0), nicht geloescht');
END;

CREATE TRIGGER dokumente_kein_loeschen BEFORE DELETE ON dokumente
WHEN EXISTS (SELECT 1 FROM versionen WHERE dokument_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Dokument hat Fassungen im Archiv und wird nicht geloescht');
END;
