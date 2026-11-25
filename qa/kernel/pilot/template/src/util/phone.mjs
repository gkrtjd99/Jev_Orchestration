// Hides the middle block of a mobile number before it is shown to staff.
export function maskPhone(phone) {
  const parts = String(phone ?? '').split('-');
  if (parts.length !== 3) return String(phone ?? '');
  return `${parts[0]}-****-${parts[2]}`;
}
