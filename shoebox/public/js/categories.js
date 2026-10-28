// Expense categories are HMRC's own Self Assessment / Making Tax Digital self-employment expense
// fields, so totals map 1:1 onto a quarterly update. `hint` is shown in the app and given to the AI.

export const EXPENSE_CATEGORIES = [
  { id: 'costOfGoods', label: 'Stock & materials', emoji: '📦', color: '#a2845e', hint: 'Goods bought to resell, raw materials, direct costs of what you sell' },
  { id: 'carVanTravelExpenses', label: 'Travel & vehicle', emoji: '🚗', color: '#007aff', hint: 'Fuel, parking, tolls, train, bus, taxi, flights, hotels on business trips, vehicle insurance and repairs' },
  { id: 'adminCosts', label: 'Office, phone & software', emoji: '🖇️', color: '#5856d6', hint: 'Stationery, postage, printing, phone and internet bills, software and app subscriptions' },
  { id: 'premisesRunningCosts', label: 'Premises', emoji: '🏢', color: '#30b0c7', hint: 'Rent, business rates, electricity, gas, water, buildings insurance, security' },
  { id: 'maintenanceCosts', label: 'Repairs & maintenance', emoji: '🔧', color: '#ff9500', hint: 'Repairs to premises, machinery or equipment (not improvements)' },
  { id: 'advertisingCosts', label: 'Advertising & marketing', emoji: '📣', color: '#ff2d55', hint: 'Adverts, website hosting and domains, flyers, business cards, sponsorship' },
  { id: 'professionalFees', label: 'Accountant & legal', emoji: '⚖️', color: '#af52de', hint: 'Accountant, solicitor, surveyor, architect, professional indemnity insurance' },
  { id: 'paymentsToSubcontractors', label: 'Subcontractors', emoji: '👷', color: '#ffcc00', hint: 'Payments to subcontractors, including under the Construction Industry Scheme' },
  { id: 'wagesAndStaffCosts', label: 'Staff costs', emoji: '🧑‍💼', color: '#34c759', hint: 'Wages, salaries, bonuses, pensions, employer NI, agency staff' },
  { id: 'financeCharges', label: 'Bank & card charges', emoji: '🏦', color: '#64d2ff', hint: 'Bank, overdraft, card and payment processing fees (Stripe, PayPal, SumUp), hire purchase interest' },
  { id: 'interestOnBankOtherLoans', label: 'Loan interest', emoji: '📈', color: '#8e8e93', hint: 'Interest on business bank and other loans' },
  { id: 'irrecoverableDebts', label: 'Bad debts', emoji: '🚫', color: '#ff3b30', hint: 'Money owed to you that you will not get, already counted as income' },
  { id: 'businessEntertainmentCosts', label: 'Client entertaining', emoji: '🥂', color: '#ff6482', hint: 'Meals, drinks or events for clients or suppliers. Not tax-deductible and no VAT reclaim' },
  { id: 'otherExpenses', label: 'Other', emoji: '🧾', color: '#8e8e93', hint: 'Anything else for the business: tools, equipment, training, trade subscriptions, protective clothing' },
];

export const INCOME_CATEGORIES = [
  { id: 'turnover', label: 'Sales & fees', emoji: '💷', color: '#34c759', hint: 'Money from customers for goods or services' },
  { id: 'other', label: 'Other business income', emoji: '💰', color: '#30b0c7', hint: 'Grants, insurance payouts, interest from business accounts' },
];

/** Never deductible for tax, and VAT on it cannot be reclaimed. */
export const NOT_DEDUCTIBLE = new Set(['businessEntertainmentCosts']);
/** Outside the scope of VAT, so left out of VAT return box 7. */
export const OUTSIDE_VAT = new Set(['wagesAndStaffCosts']);

export const EXPENSE_IDS = EXPENSE_CATEGORIES.map((c) => c.id);
export const INCOME_IDS = INCOME_CATEGORIES.map((c) => c.id);

const byId = new Map([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((c) => [c.id, c]));
export const categoryOf = (id, kind = 'expense') =>
  (kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).find((c) => c.id === id)
  ?? (kind === 'income' ? INCOME_CATEGORIES[0] : byId.get('otherExpenses'));
