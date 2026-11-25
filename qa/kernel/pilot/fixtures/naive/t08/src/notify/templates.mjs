// Wording of customer messages, per locale. Placeholders look like {name}.
export const templates = {
  parcelArrived: {
    en: 'Hi {name}, your parcel is waiting in locker {locker}. Pickup code: {code}',
    ko: '{name}님, 택배가 {locker} 보관함에 도착했습니다. 수령 코드: {code}',
  },
  pickupReminder: {
    en: 'Hi {name}, your parcel has been in locker {locker} for {days} days. Please collect it soon.',
    ko: '{name}님, 택배가 {locker} 보관함에 {days}일째 보관 중입니다. 빠른 수령 부탁드립니다.',
  },
  codeExpired: {
    en: 'Hi {name}, the pickup code for locker {locker} is no longer valid. Ask the front desk for a new one.',
    ko: '{name}님, {locker} 보관함의 수령 코드가 만료되었습니다. 안내 데스크에서 새 코드를 받아 주세요.',
  },
  parcelReturned: {
    en: 'Hi {name}, your parcel was not collected in time and has been returned to {sender}. Please contact the sender to arrange a new delivery.',
    ko: '{name}님, 보관 기간 안에 수령하지 않으신 택배가 {sender}(으)로 반송되었습니다. 재배송은 보내신 분께 문의해 주세요.',
  },
};

export function render(key, locale, vars = {}) {
  const template = templates[key];
  if (!template) throw new Error(`no template named ${key}`);
  const text = template[locale] ?? template.en;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}
