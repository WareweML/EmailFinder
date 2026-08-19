import { getOrCreateDefault, saveWorkbook } from "../src/lib/email-finder/workbook-store.ts";
import { runActionOnRow } from "../src/lib/email-finder/column-actions.ts";

let wb = await getOrCreateDefault();
const row = wb.companyRows[0];
console.log("wb", wb.name, "row", row.domain);

wb = await runActionOnRow(wb, row.id, "company_enrich");
console.log("company", wb.companyRows[0].cells.company);
console.log("legal", wb.companyRows[0].cells.legal);
console.log("mx", wb.companyRows[0].cells.mx);

wb = await runActionOnRow(wb, row.id, "phone");
console.log("phone", wb.companyRows[0].cells.phone);

wb = await runActionOnRow(wb, row.id, "tech_stack");
console.log("tech", wb.companyRows[0].cells.tech);

await saveWorkbook(wb);
console.log("saved", wb.id);
