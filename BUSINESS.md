# POT Watch — Business Model

**One line:** freemium node-ops intelligence for Portaldot, where the paid
product is *provably delivered* — every alert a Pro subscriber receives is
also a transaction on the Portaldot chain.

## Who pays, and why
| Customer | Pain | Willingness to pay |
|---|---|---|
| **Validator operators** (testnet → mainnet) | Downtime = lost era rewards & slash risk; existing monitors are generic (Polkadot.js, Grafana stacks) and not Portaldot-specific | High — an era of missed authorship on a funded node exceeds a month of Pro |
| **Delegators / nomination desks** | No transparent, per-validator uptime & slash history to delegate against | Medium — analytics subscriptions & reports |
| **Node-operator collectives & infra hosts** | Need branded monitoring for their fleets without building it | High — white-label dashboards |
| **Wallets, explorers, staking UIs** | Need historical health + fee-model data they cannot scrape reliably | Medium — data API licenses |

## Revenue streams
1. **Free tier** — public dashboard (health score, block stream, validator
   table, on-chain alert feed). Zero marginal cost (static site + public RPCs).
   Purpose: operator acquisition + ecosystem good-will + judge-visible proof.
2. **Pro alerts — settled on-chain in POT.** The AlertRegistry already stores
   subscriptions (kind, target, threshold, channel). Pro = custom thresholds,
   multi-channel delivery (Discord + Telegram), tighter cadence, SLA-grade
   uptime certificates. Billing rides the same surface as the product:
   subscription payments and `recordFire` receipts (~0.015 tPOT each, native
   surface) live on Portaldot itself — **revenue that is auditable on-chain**,
   which no competing monitor can claim.
3. **B2B reports & white-label.** Monthly validator performance / slash-risk
   PDFs for staking teams; branded dashboards for operator collectives
   (fixed monthly fee per fleet).
4. **Data API.** Historical health scores, BABE authorship attribution and the
   dual-VM fee-model dataset (see `docs/DEPLOYMENT.md`) as a paid API for
   wallets/explorers.

## Unit economics (measured, not assumed)
- Cost per on-chain alert receipt: **~0.015 tPOT** (native surface; measured
  from deployment interactions). At 100 fires/day that is ~1.5 tPOT/day —
  trivially below any Pro price point.
- Our own deploy research caps infra cost: native deployment of the whole
  contract suite cost **~0.36 tPOT** vs ~289 tPOT through the EVM surface —
  the same tooling keeps our COGS (and every future team's) near zero.
- Dashboard hosting: free (GitHub Pages / any static host); reads use public
  RPCs. Gross margin on Pro ≈ 100% minus RPC/worker time.

## Why Portaldot is essential (ecosystem fit)
- The product is *only* possible on Portaldot: dual-VM (Substrate + Revive EVM)
  means alerts can be **subscribed natively and proven on the EVM surface** —
  our dashboard reads them with zero backend.
- Post-hackathon path: mainnet launch of AlertRegistry + Pro billing =
  recurring on-chain activity for the network (every alert = a transaction).
- Open-sourced native deploy tooling + fee-model research lower the barrier
  for every subsequent Portaldot team — ecosystem contribution independent of
  our revenue.

## Go-to-market (first 90 days post-hackathon)
1. Ship with Portaldot mainnet launch; free dashboard announced in Portaldot
   Discord/forums (audience already assembled by the hackathon).
2. Convert the hackathon validator set (2 testnet validators → mainnet cohort)
   into design partners for Pro.
3. Apply to the Portaldot ecosystem support program for infra subsidies and
   co-marketing; publish quarterly uptime reports as PR.

## Moat
- On-chain subscription + fire ledger = switch cost and proof-of-delivery no
  off-chain monitor can replicate.
- Hand-rolled SCALE/BABE/fee-model expertise = months of competitor catch-up.
- First-mover data: continuous health history from day one of V3 testnet.

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Small validator set today | Price for mainnet scale; free tier keeps relevance at any size |
| RPC availability | Multi-endpoint retry-hardened client (already shipped) |
| Billing on-chain complexity | Start with manual Pro activation + on-chain receipt; automate in v2 |
