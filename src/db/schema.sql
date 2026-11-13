-- Uso local directo: mysql -u root -p < src/db/schema.sql
-- En Railway (o cualquier ambiente con la DB ya creada): node scripts/init-db.js
-- (el script se salta CREATE DATABASE/USE y ejecuta solo las tablas).
-- DBs creadas ANTES de un cambio de schema: aplicar la migración que toque en
-- src/db/migrations/ (este archivo ya trae el schema final para DBs nuevas).
CREATE DATABASE IF NOT EXISTS whatsapp_bot;
USE whatsapp_bot;

-- patients (registro de pacientes que han agendado alguna vez).
-- "Primera vez" / "recurrente" se calcula on-demand desde appointments
-- con status='completed'; no hay contadores denormalizados aquí.
CREATE TABLE IF NOT EXISTS patients (
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- appointments
CREATE TABLE IF NOT EXISTS appointments (
  id CHAR(36) NOT NULL,                          -- UUID v4
  patient_phone VARCHAR(20) NOT NULL,
  patient_name VARCHAR(255) NOT NULL,
  consultation_type VARCHAR(50) NOT NULL,        -- primera_vez | subsecuente (llaves de consultationTypes.json)
  location VARCHAR(50) NOT NULL,                 -- norte | sur (slugs de availability.json)
  scheduled_at DATETIME NOT NULL,
  duration_min INT NOT NULL,
  status ENUM('pending','confirmed','cancelled','completed','rescheduled') NOT NULL,
  patient_notes TEXT NULL,                       -- Notas opcionales para la doctora
  caldav_event_uid VARCHAR(255) NULL,            -- UID en iCloud (para borrar)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reminder_sent_at DATETIME NULL,
  reminder_message_id VARCHAR(128) NULL,         -- wamid del recordatorio (correlaciona statuses de Meta)
  reminder_delivery_status ENUM('sent','delivered','read','failed') NULL,
  reminder_delivery_error VARCHAR(255) NULL,     -- código + motivo si Meta no lo entregó
  confirmed_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  rescheduled_from_id CHAR(36) NULL,             -- FK a otra cita si fue reagendamiento
  PRIMARY KEY (id),
  KEY idx_appointments_scheduled (scheduled_at),
  KEY idx_appointments_status (status),
  KEY idx_appointments_patient (patient_phone),
  KEY idx_appointments_reminder_msg (reminder_message_id),
  CONSTRAINT fk_appointments_patient
    FOREIGN KEY (patient_phone) REFERENCES patients(phone)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_appointments_rescheduled_from
    FOREIGN KEY (rescheduled_from_id) REFERENCES appointments(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- waitlist (lista de espera: pacientes con cita lejana que aceptaron ser
-- consideradas si se libera un hueco más cercano por una cancelación).
-- La elegibilidad se calcula al consultar (cita ligada activa y posterior al
-- hueco liberado) — cancelar/completar la cita saca a la paciente sola.
CREATE TABLE IF NOT EXISTS waitlist (
  id CHAR(36) NOT NULL,                          -- UUID v4
  appointment_id CHAR(36) NOT NULL,              -- la cita lejana vigente de la paciente
  status ENUM('waiting','fulfilled','removed') NOT NULL DEFAULT 'waiting',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_waitlist_appointment (appointment_id),
  CONSTRAINT fk_waitlist_appointment
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- slot_offers (huecos liberados por cancelación que la doctora puede ofrecer
-- a la lista de espera). Es una state machine persistente porque la doctora
-- y la paciente responden por WhatsApp con horas de diferencia (payloads
-- stateless en los botones, igual que los recordatorios):
--   pending_doctor  → esperando que la doctora elija paciente (o deje libre)
--   offered_patient → oferta enviada a una paciente, esperando su respuesta
--   accepted        → la paciente aceptó y su cita se movió al hueco
--   closed          → la doctora lo dejó libre, se ocupó por otra vía o expiró
CREATE TABLE IF NOT EXISTS slot_offers (
  id CHAR(36) NOT NULL,                          -- UUID v4
  source_appointment_id CHAR(36) NULL,           -- la cita cancelada que liberó el hueco
  location VARCHAR(50) NOT NULL,                 -- norte | sur
  scheduled_at DATETIME NOT NULL,                -- inicio del hueco (UTC)
  duration_min INT NOT NULL,
  status ENUM('pending_doctor','offered_patient','accepted','closed') NOT NULL DEFAULT 'pending_doctor',
  offered_waitlist_id CHAR(36) NULL,             -- entrada de waitlist con la oferta en curso
  declined_waitlist_ids JSON NULL,               -- entradas que ya rechazaron este hueco
  offer_message_id VARCHAR(128) NULL,            -- wamid de la oferta a la paciente (statuses de Meta)
  doctor_browsed_at DATETIME NULL,               -- la doctora abrió la lista en texto (su texto = nombre)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL
    DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_slot_offers_status (status),
  KEY idx_slot_offers_offer_msg (offer_message_id),
  CONSTRAINT fk_slot_offers_source
    FOREIGN KEY (source_appointment_id) REFERENCES appointments(id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_slot_offers_waitlist
    FOREIGN KEY (offered_waitlist_id) REFERENCES waitlist(id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- conversations (estado conversacional persistente)
CREATE TABLE IF NOT EXISTS conversations (
  phone VARCHAR(20) NOT NULL,
  current_step VARCHAR(50) NOT NULL,
  context_data JSON NULL,                        -- Datos parciales del flujo
  flow_type ENUM('appointment','reschedule','cancellation') NULL,
  updated_at DATETIME NOT NULL
    DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
