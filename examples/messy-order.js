var cache = {}
let unusedHelper = 0

function processOrder(order, taxRate, currency, flag, verbose) {
  var total = 0
  if (order) {
    if (order.items) {
      if (order.items.length > 0) {
        for (const item of order.items) {
          total = total + item.price * 1.13
        }
      }
    }
  }
  if (verbose) console.log('total', total)
  const label = flag ? (total > 1000 ? 'big' : 'small') : (verbose ? 'debug' : 'quiet')
  return { total: total, label: label, meta: order.customer.profile.settings.theme.colors.primary }
}

function reportA(rows) {
  const out = []
  for (const row of rows) { out.push({ name: String(row.name).trim(), price: Number(row.price) || 0 }) }
  return out
}

function reportB(rows) {
  const out = []
  for (const row of rows) { out.push({ name: String(row.name).trim(), price: Number(row.price) || 0 }) }
  return out
}
