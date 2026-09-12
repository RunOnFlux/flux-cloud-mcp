# Flux Cloud MCP server

An [MCP](https://modelcontextprotocol.io) server that lets any AI agent use
[Flux Cloud](https://runonflux.com), the decentralized cloud: quote an app in
US dollars, deploy it, pay for it, watch it come up, read its logs, update it,
and cancel it. Works with Claude Code, Claude Desktop, Cursor, Windsurf,
OpenCode and every other MCP host.

There is no account. Two keys are the whole identity:

| Key                        | Address               | Role                                                                 |
| -------------------------- | --------------------- | -------------------------------------------------------------------- |
| `FLUX_ID_PRIVATE_KEY`      | Flux ID, `1...`       | Owns apps. Signs specifications and API sessions. Never holds funds. |
| `FLUX_PAYMENT_PRIVATE_KEY` | Flux address, `t1...` | Holds FLUX and pays deployment fees on-chain.                        |

The server generates a pair for you (`flux_generate_keys`); fund the payment
address with FLUX and deploy.

## Pricing policy

Every price this server shows is the **Flux Cloud USD price**, the same one
[home.runonflux.io](https://home.runonflux.io) charges, converted to FLUX at the
live market rate with the 5 percent pay-in-FLUX discount. Quotes come from the
network itself (`/apps/calculatefiatandfluxprice`), so they include the $0.99
minimum, hardware and term discounts, and update credits.

The blockchain's own acceptance threshold is several times lower. It is never
shown as a price; it is only checked as a guard before a payment is broadcast.

## Install

```bash
npm install -g @runonflux/flux-cloud-mcp     # or: yarn global add @runonflux/flux-cloud-mcp
```

Or run it without installing: `npx @runonflux/flux-cloud-mcp`.

### Claude Code

```bash
claude mcp add flux-cloud -s user \
  -e FLUX_ID_PRIVATE_KEY=<wif> -e FLUX_PAYMENT_PRIVATE_KEY=<wif> \
  -- npx -y @runonflux/flux-cloud-mcp
```

### Claude Desktop, Cursor, Windsurf (JSON config)

```json
{
  "mcpServers": {
    "flux-cloud": {
      "command": "npx",
      "args": ["-y", "@runonflux/flux-cloud-mcp"],
      "env": {
        "FLUX_ID_PRIVATE_KEY": "<wif of the Flux ID>",
        "FLUX_PAYMENT_PRIVATE_KEY": "<wif of the payment address>"
      }
    }
  }
}
```

Keys are optional. Without them every read-only tool works, and
`flux_generate_keys` will create a pair to put into the config.

### OpenCode

```json
{
  "mcp": {
    "flux-cloud": {
      "type": "local",
      "command": ["npx", "-y", "@runonflux/flux-cloud-mcp"],
      "environment": {
        "FLUX_ID_PRIVATE_KEY": "<wif>",
        "FLUX_PAYMENT_PRIVATE_KEY": "<wif>"
      }
    }
  }
}
```

## Tools

| Tool                    | What it does                                                             | Spends FLUX    |
| ----------------------- | ------------------------------------------------------------------------ | -------------- |
| `flux_get_identity`     | Flux ID, payment address, balance in FLUX and USD                        | no             |
| `flux_generate_keys`    | New Flux ID + payment key pair with setup instructions                   | no             |
| `flux_get_pricing`      | USD rate card, FLUX/USD rate, discounts, reference sizes                 | no             |
| `flux_build_spec`       | Simple description (image, ports, cpu/ram/hdd, months) to a full v8 spec | no             |
| `flux_validate_spec`    | Local rules plus verification on a FluxOS node                           | no             |
| `flux_quote_app`        | USD price and FLUX to pay, for a registration or an update               | no             |
| `flux_deploy_app`       | Plan (default) or, with `confirm=true`, sign, broadcast and pay          | with `confirm` |
| `flux_wait_for_app`     | Poll until accepted and instances run; returns URLs                      | no             |
| `flux_get_app`          | Any app's spec, expiry, instances, URLs                                  | no             |
| `flux_list_my_apps`     | Apps owned by the Flux ID, with instance counts and days left            | no             |
| `flux_get_app_logs`     | Container logs from a running instance (owner only)                      | no             |
| `flux_get_app_stats`    | Live CPU/memory/network of an instance (owner only)                      | no             |
| `flux_control_app`      | Restart, redeploy or remove instances, per node or globally              | no             |
| `flux_cancel_app`       | End an app early by shortening its term                                  | with `confirm` |
| `flux_get_network_info` | Node counts, height, FLUX/USD, deployment address                        | no             |

Resources `flux://guide/overview`, `flux://guide/spec-format`,
`flux://guide/pricing` and `flux://guide/gotchas` give the agent the domain
knowledge; the `deploy_on_flux` prompt walks it through a deployment.

## A typical session

```
> deploy nginx on flux, 3 instances, one month

flux_get_identity      -> Flux ID 1Ab..., payer t1Cd..., 996.98 FLUX ($48.74)
flux_build_spec        -> v8 spec, port 39978 -> 80, r:/data, valid
flux_quote_app         -> $0.99 for 1 month, pay 19.24 FLUX (5% FLUX discount)
   user agrees
flux_deploy_app confirm=true
                       -> message hash 8d2f..., paid 19.24 FLUX, txid 0c41...
flux_wait_for_app      -> accepted at height 2941560, 3/3 instances running
                          https://myapp.app.runonflux.io
```

## How a deployment works

1. The spec is verified through `api.runonflux.io` exactly as it will be at
   registration (image reachable, architecture, ports, name free). If the
   balancer refuses, a few healthy nodes are probed and tried in turn.
2. The network quotes the USD price; the server checks the payer's balance.
3. With `confirm=true` the Flux ID signs the spec, the same endpoint
   broadcasts it to the network and returns a 64-character message hash.
4. The payment address sends the quoted FLUX to the network deployment
   address with the hash in an OP_RETURN output. Right before signing, the
   amount is re-checked against a freshly fetched price table, because an
   underpaid message is dropped silently and the FLUX is not refunded.
5. Nodes pair the confirmed payment with the message and publish the app.
   Instances then spawn and pull the image.

Updates use the same tool: an existing app of the same owner gets a
`fluxappupdate` message and the network credits the unused part of the old
term. Private (enterprise) apps are supported through the `enterprise`
argument: components are encrypted for the network and only ArcaneOS nodes
can run them.

## Hosted server: mcp.runonflux.com

The same server also runs on Flux Cloud itself, over Streamable HTTP, for
hosts that cannot start a local process (claude.ai connectors, ChatGPT,
browser and mobile agents). Add it as a remote MCP server:

```
https://mcp.runonflux.com/mcp   (also https://mcp.runonflux.io/mcp)
```

The hosted server holds no keys. Read-only tools need none. Tools that sign
or pay take `fluxIdPrivateKey` and `paymentPrivateKey` as call arguments,
used in memory for that call and never logged or stored. The server's
instructions tell agents to create a dedicated pair with `flux_generate_keys`
and to have the user fund only what a deployment needs, rather than asking
for the keys of a wallet used elsewhere. Anything typed into a chat passes
through the AI vendor and the host's history, so treat such a pair as
disposable and keep its balance small. For larger budgets, run the local
server, where keys never leave your machine.

Run your own copy with Docker:

```bash
docker run -p 3000:3000 runonflux/flux-cloud-mcp
```

It is stateless, so any number of instances can sit behind one load balancer.
`GET /healthz` reports liveness. The Flux app specification that runs the
public instance is in `deploy/cloudmcp.json`.

## Configuration

| Variable                   | Default                                            | Purpose                                       |
| -------------------------- | -------------------------------------------------- | --------------------------------------------- |
| `FLUX_ID_PRIVATE_KEY`      |                                                    | WIF of the Flux ID (owner)                    |
| `FLUX_PAYMENT_PRIVATE_KEY` |                                                    | WIF of the paying address                     |
| `FLUX_API_URL`             | `https://api.runonflux.io`                         | Load-balanced FluxOS API for reads and quotes |
| `FLUX_NODE_URL`            | auto                                               | Pin one FluxOS node for registrations         |
| `FLUX_EXPLORER_URLS`       | `explorer.runonflux.io,flux-explorer.sspwallet.io` | Insight explorers for UTXOs and broadcast     |
| `FLUX_STATS_URL`           | `https://stats.runonflux.io`                       | USD rate card                                 |
| `FLUX_RATES_URL`           | `https://viprates.runonflux.io`                    | FLUX market rate                              |

## Security notes

- Private keys stay in the server process. No tool ever returns a configured
  key; `flux_generate_keys` returns only the keys it just created.
- Nothing is spent unless a tool is called with `confirm=true`. Hosts that
  ask before tool calls will show the USD amount in the arguments' context.
- FluxOS sessions are self-issued signed phrases valid for a few hours; no
  password or token is stored anywhere.
- Use a dedicated payment address holding only what you intend to spend.

## Development

```bash
yarn install
yarn type-check && yarn lint && yarn format:check && yarn build && yarn test
yarn test:live      # differential test of the USD estimator against the network
```

The USD estimator, the specification formatter and the consensus guard mirror
the FluxOS code (`appSpecHelpers.js`, `appUtilities.js`, `messageVerifier.js`)
and the live test checks the estimator against the network on every run.

## License

MIT
