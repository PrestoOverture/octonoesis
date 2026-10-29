// @ts-nocheck -- standalone eval fixture
import { options } from './options'
import { render } from './render'
export function checkout(amount, overrides = {}) { const config = options(overrides); return render(amount, config.currency) }
