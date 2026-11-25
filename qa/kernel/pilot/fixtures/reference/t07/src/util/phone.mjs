// Hides the middle block of a mobile number before it is shown to staff.
export function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/-/g, '');
  if (!/^\d{10,11}$/.test(digits)) return String(phone ?? '');
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}
