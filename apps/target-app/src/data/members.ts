/**
 * Synthetic member records. Names and numbers are deliberately fake and unlike real data.
 * Balances are integers of cents to avoid float formatting surprises.
 */
export interface Account {
  id: string;
  type: "Checking" | "Savings" | "Christmas Club" | "Money Market";
  nickname: string;
  balanceCents: number;
  opened: string;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  since: string;
  branch: string;
  status: "Active" | "Restricted";
  accounts: Account[];
}

const seed: Member[] = [
  {
    id: "10042", firstName: "Alex", lastName: "Sample", since: "2014-03-11", branch: "Main Street", status: "Active",
    accounts: [
      { id: "10042-01", type: "Checking", nickname: "Everyday", balanceCents: 248_317, opened: "2014-03-11" },
      { id: "10042-02", type: "Savings", nickname: "Rainy Day", balanceCents: 123_456, opened: "2015-07-02" },
    ],
  },
  {
    id: "10077", firstName: "Jordan", lastName: "Placeholder", since: "2018-09-30", branch: "Riverside", status: "Active",
    accounts: [
      { id: "10077-01", type: "Checking", nickname: "Primary", balanceCents: 51_200, opened: "2018-09-30" },
      { id: "10077-02", type: "Savings", nickname: "Vacation", balanceCents: 890_004, opened: "2019-01-15" },
    ],
  },
  {
    id: "10101", firstName: "Sam", lastName: "Fixture", since: "2009-12-01", branch: "Main Street", status: "Active",
    accounts: [
      { id: "10101-01", type: "Savings", nickname: "Nest Egg", balanceCents: 4_500_000, opened: "2009-12-01" },
    ],
  },
  {
    id: "10233", firstName: "Casey", lastName: "Mock", since: "2021-05-19", branch: "Hilltop", status: "Restricted",
    accounts: [
      { id: "10233-01", type: "Checking", nickname: "Main", balanceCents: 1_250, opened: "2021-05-19" },
      { id: "10233-02", type: "Savings", nickname: "Emergency", balanceCents: 0, opened: "2021-05-19" },
    ],
  },
  {
    id: "10999", firstName: "Riley", lastName: "Test", since: "2023-02-08", branch: "Riverside", status: "Active",
    accounts: [
      { id: "10999-01", type: "Checking", nickname: "Spending", balanceCents: 77_777, opened: "2023-02-08" },
      { id: "10999-02", type: "Savings", nickname: "Goals", balanceCents: 30_000, opened: "2023-02-08" },
      { id: "10999-03", type: "Money Market", nickname: "Growth", balanceCents: 1_500_000, opened: "2024-11-20" },
    ],
  },
];

/** In-memory store; reset() restores the seed so tests and demos start clean. */
export class MemberStore {
  private members = new Map<string, Member>();
  private confirmations = 700_000;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.members.clear();
    for (const m of seed) this.members.set(m.id, structuredClone(m));
    this.confirmations = 700_000;
  }

  find(id: string): Member | undefined {
    return this.members.get(id.trim());
  }

  openSubAccount(memberId: string, input: { type: Account["type"]; nickname: string; depositCents: number }): { account: Account; confirmation: string } {
    const m = this.find(memberId);
    if (!m) throw new Error(`member ${memberId} not found`);
    const seq = String(m.accounts.length + 1).padStart(2, "0");
    const account: Account = {
      id: `${m.id}-${seq}`,
      type: input.type,
      nickname: input.nickname,
      balanceCents: input.depositCents,
      opened: new Date().toISOString().slice(0, 10),
    };
    m.accounts.push(account);
    this.confirmations += 1;
    return { account, confirmation: `CU-${this.confirmations}` };
  }
}

export function formatMoney(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100).toLocaleString("en-US");
  const rest = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${dollars}.${rest}`;
}
