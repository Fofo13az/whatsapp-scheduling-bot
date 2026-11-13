/**
 * Utilidades de comparación de teléfonos.
 *
 * Caso México: los wa_id de celulares llegan como 521XXXXXXXXXX (el "1"
 * histórico tras el código de país) pero la Cloud API registra los números
 * en formato moderno 52XXXXXXXXXX. Cualquier comparación o búsqueda por
 * teléfono debe tolerar ambas variantes (y el "+" opcional de E.164).
 */

/** Normaliza al formato moderno sin "+": "521..."/"+52..." → "52...". */
export function normalizeMxPhone(phone) {
  let digits = String(phone ?? '').replace(/^\+/, '');
  if (digits.startsWith('521') && digits.length === 13) {
    digits = `52${digits.slice(3)}`;
  }
  return digits;
}

/**
 * ¿Dos teléfonos refieren al mismo número? Tolera "+" y la variante 521/52.
 */
export function samePhone(a, b) {
  return normalizeMxPhone(a) === normalizeMxPhone(b);
}

/**
 * Variantes equivalentes de un número para búsquedas en DB (la columna
 * patient_phone guarda el wa_id tal cual llegó, que puede ser 521... o 52...).
 *
 * @param {string} phone
 * @returns {string[]}  1 o 2 formas: ["52...", "521..."]
 */
export function mxPhoneVariants(phone) {
  const modern = normalizeMxPhone(phone);
  const variants = [modern];
  if (modern.startsWith('52') && modern.length === 12) {
    variants.push(`521${modern.slice(2)}`);
  }
  return variants;
}
