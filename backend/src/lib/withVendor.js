import { sortAccounts } from "./accountSort.js";

export function withVendor(row) {
  if (!row) return row;
  const vendor = row.lists && row.lists.name ? row.lists.name : "";
  const { lists, ...rest } = row;
  return { ...rest, vendor };
}

export async function fetchAccountRows(client, columns) {
  const pageSize = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await client
      .from("accounts")
      .select(columns)
      .order("updated_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return sortAccounts(all.map(withVendor));
}
