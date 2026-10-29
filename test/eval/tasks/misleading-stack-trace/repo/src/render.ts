// @ts-nocheck -- standalone eval fixture
export function render(amount, currency) {
 if (!['USD','EUR'].includes(currency)) throw new Error('receipt renderer: unsupported currency')
 return `${currency} ${amount.toFixed(2)}`
}
