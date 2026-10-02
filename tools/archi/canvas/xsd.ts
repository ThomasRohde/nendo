// The Open Exchange schema check (W-121): archi-online's own validation, libxml2 compiled to
// WebAssembly and Archi 5.9's five schemas, bundled by tools/archi/build-canvas.mjs into
// extensions/archi/xsd.js. It is a file of its own, loaded only when an export is checked,
// because libxml2 is larger than the whole canvas and nothing else needs it.
export { validateExchangeXml } from '@archi/model/io/exchange-xml/validation';
export { EXCHANGE_SCHEMAS } from '@archi/model/io/exchange-xml/schemas';
