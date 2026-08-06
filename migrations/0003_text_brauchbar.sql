-- Urteil, ob aus einer Fassung brauchbarer Text gewonnen wurde.
--
-- Bewusst als gespeichertes Urteil und nicht als Bedingung in jeder Abfrage:
-- die Regel wird an drei Stellen gebraucht (Seite, MCP, Meldungen), und eine
-- dreifach abgeschriebene Schwelle laeuft frueher oder spaeter auseinander.
ALTER TABLE versionen ADD COLUMN text_brauchbar INTEGER NOT NULL DEFAULT 1;
