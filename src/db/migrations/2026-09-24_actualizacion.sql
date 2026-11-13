-- Migración de la actualización del 23/09/2026 .
--
-- Solo agrega columnas NULL: el código anterior funciona igual con ellas, así
-- que en Railway se aplica ANTES de pushear el código nuevo (el boot del
-- código nuevo verifica que existan y falla fast si falta esta migración).
--
-- Aplicar UNA sola vez (MySQL no soporta ADD COLUMN IF NOT EXISTS):
--   - Railway: pestaña Data del servicio MySQL → editor SQL → pegar y correr.
--   - Local:   node scripts/init-db.js --migration src/db/migrations/2026-09-24_actualizacion.sql

-- Seguimiento de entrega del recordatorio (webhook de statuses de Meta):
-- el wamid permite correlacionar los statuses sent/delivered/read/failed.
ALTER TABLE appointments
  ADD COLUMN reminder_message_id VARCHAR(128) NULL AFTER reminder_sent_at,
  ADD COLUMN reminder_delivery_status ENUM('sent','delivered','read','failed') NULL AFTER reminder_message_id,
  ADD COLUMN reminder_delivery_error VARCHAR(255) NULL AFTER reminder_delivery_status,
  ADD KEY idx_appointments_reminder_msg (reminder_message_id);

-- Lista de espera: wamid de la oferta a la paciente (si Meta no la entrega,
-- la oferta regresa a la doctora) y marca de cuándo la doctora abrió la lista
-- en texto (su siguiente mensaje de texto se interpreta como nombre).
ALTER TABLE slot_offers
  ADD COLUMN offer_message_id VARCHAR(128) NULL AFTER declined_waitlist_ids,
  ADD COLUMN doctor_browsed_at DATETIME NULL AFTER offer_message_id,
  ADD KEY idx_slot_offers_offer_msg (offer_message_id);
