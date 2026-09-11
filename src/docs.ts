/** Guide texts served as MCP resources so a host can load them into context. */

export const OVERVIEW = `# Flux Cloud, for agents

Flux Cloud is a decentralized cloud: thousands of independently operated
nodes run Docker containers for a monthly price paid in FLUX. There is no
account to create. Two secp256k1 keys are all the identity there is:

- **Flux ID** (a "1..." address, also called ZelID): owns apps. It signs the
  app specification and API sessions. It never holds funds.
- **Payment address** (a "t1..." address): holds FLUX and pays deployment
  fees on-chain. It can be rotated without changing app ownership.

Both come from \`FLUX_ID_PRIVATE_KEY\` and \`FLUX_PAYMENT_PRIVATE_KEY\` in this
server's environment. \`flux_generate_keys\` creates a fresh pair.

## How a deployment works

1. Describe the app: name, Docker image(s), ports, cpu/ram/hdd per component,
   instance count, term. \`flux_build_spec\` turns that into a v8 spec.
2. \`flux_quote_app\` returns the price in USD and the FLUX to pay.
3. \`flux_deploy_app\` with \`confirm: true\` validates the spec on a node, signs it
   with the Flux ID, broadcasts it, and pays the quoted FLUX from the payment
   address. The transaction carries the message hash in an OP_RETURN.
4. \`flux_wait_for_app\` (or \`flux_get_app\`) reports acceptance and the IPs
   where instances run. Acceptance takes a few minutes; images then pull.

An existing app of the same owner is **updated** by the same call: the new
spec replaces the old, and the network credits the unused part of the old term.
To stop an app early, update it with a very short term (\`flux_cancel_app\`).

## Reaching an app

Each instance is reachable at \`http://<node-ip>:<port>\` for every public port
in the spec. The network also serves \`https://<appname>.app.runonflux.io\`
(an alias for the first public port) and \`<appname>_<port>.app.runonflux.io\`
for every public port, load balanced across instances. Custom domains go in the component's
\`domains\` list, one per port, and need a CNAME to \`<appname>.app.runonflux.io\`.

## Rules of thumb

- Names: 1-63 chars, letters/digits/inner hyphens, must not start with "flux"
  or "zel", unique network-wide.
- Public ports: pick from 31000-39999 unless you need a specific one; ports
  0-1023, 8080, 8081, 8443 and 6667 are "enterprise ports" billed extra.
- Persisted paths must be prefixed \`r:\` (replicated) to survive instance moves.
- Images need an explicit tag and must be public unless \`repoauth\` is set.
- One network month is 88000 blocks (about 30.5 days). Terms run 1 block to
  12 months; 3+ months earn 3 to 12 percent off.
- Flux sets only the container's Cmd, never Entrypoint.
`;

export const SPEC_FORMAT = `# Flux v8 application specification

\`\`\`json
{
  "version": 8,
  "name": "myapp",
  "description": "What it is",
  "owner": "1YourFluxIdAddress",
  "compose": [
    {
      "name": "web",
      "description": "Web front end",
      "repotag": "nginx:1.27-alpine",
      "ports": [31080],
      "domains": [""],
      "environmentParameters": ["KEY=value"],
      "commands": [],
      "containerPorts": [80],
      "containerData": "r:/usr/share/nginx/html",
      "cpu": 0.5,
      "ram": 500,
      "hdd": 5,
      "repoauth": ""
    }
  ],
  "instances": 3,
  "contacts": [],
  "geolocation": [],
  "expire": 88000,
  "nodes": [],
  "staticip": false,
  "enterprise": ""
}
\`\`\`

Field notes:

- \`compose\`: 1-10 components. Each is one container. Components of one app
  share a network and reach each other by component name.
- \`ports\` / \`containerPorts\` / \`domains\`: parallel arrays, one entry per
  exposed port. \`domains\` entries are "" or a custom domain.
- \`environmentParameters\`: up to 20 "KEY=value" strings.
- \`commands\`: up to 20 strings, passed as the container Cmd.
- \`containerData\`: the path inside the container that persists. Prefixes:
  \`r:\` replicate across instances (Syncthing), \`g:\` primary/standby
  replication, \`s:\` sync only. Multiple paths: "r:/data|/config".
- \`cpu\`: 0.1 to 15 in 0.1 steps. \`ram\`: 100 to 59000 MB in 100 MB steps.
  \`hdd\`: 1 to 820 GB whole numbers.
- \`instances\`: 1-100 copies, each on a different node.
- \`expire\`: term in blocks. 88000 = 1 month. Max 1056000 (12 months).
- \`geolocation\`: rules like "acEU" (allow continent EU), "acNA_US" (allow a
  country), "a!cAS" (deny a continent), "acALL". Empty means anywhere.
- \`nodes\`: pin to specific node IPs (adds the scope surcharge).
- \`staticip\`: only nodes with a static IP (surcharge).
- \`enterprise\`: "" for a normal app. For a private app the components are
  encrypted into this field and \`compose\` is published empty; only the node
  running it can decrypt. Use \`enterprise\` in \`flux_deploy_app\`.
`;

export const PRICING = `# Flux Cloud pricing

Prices are set in US dollars and paid in FLUX. This server always quotes the
Flux Cloud USD price, converted at the live FLUX market rate.

Per month, per instance-third of the app's resource total (an app's resources
are priced as a single node's share; the per-instance figure is total / 3):

| Resource | USD / month |
|---|---|
| 0.1 CPU core | $0.15 |
| 100 MB RAM | $0.05 |
| 1 GB SSD | $0.02 |
| enterprise port (0-1023, 8080, 8081, 8443, 6667) | $2.00 each |
| node pinning or private (enterprise) app | $4.00 |
| static IP nodes | $2.00 |

Then: multiplied by the instance count; minimum $0.99 per app per month;
small apps (under 3 cores, 6 GB RAM, 150 GB and fewer than 4 instances) get
20 percent off, medium apps 10 percent off; primary/standby ("g:") storage 20
percent off; terms of 3, 6 and 9+ months get 3, 6 and 12 percent off.

Paying in FLUX earns a 5 percent discount, so
\`FLUX to pay = USD / market rate x 0.95\`.

\`flux_quote_app\` returns the authoritative figure from the network; the same
endpoint prices updates, crediting the unused part of the previous term.

Worked example: one component with 0.5 CPU, 500 MB, 5 GB, 3 instances, 1 month
= (0.75 + 0.25 + 0.10) / 3 = $0.37 per instance, x3 = $1.11, small-app
discount = $0.89, floored to $0.99 per month.
`;

export const GOTCHAS = `# Things that are easy to get wrong on Flux

- **Underpaying burns FLUX.** Nodes drop an underpaid message silently and the
  payment is not refunded. This server pays the quoted amount and re-checks
  the network's minimum immediately before broadcasting.
- **The message lives one hour.** Payment has to be broadcast within an hour of
  registration; this server does both in one step.
- **Acceptance is not instant.** The payment needs a confirmation (about 30
  seconds per block), then nodes pair it with the message. Expect 2-10
  minutes, then image pull time.
- **Node-local data disappears.** Instances move when nodes churn. Persist
  with \`r:\` and run 3+ instances if the data matters.
- **Entrypoint images.** Flux only sets Cmd, so an image whose ENTRYPOINT is a
  binary cannot be given a shell command through \`commands\`.
- **Ports must be unique per node.** Two apps using the same public port
  cannot share a node; pick unusual ports in 31000-39999.
- **Non-streamed HTTP through the shared domain times out at 25 s.** Long
  requests must stream or use the direct \`ip:port\`.
- **Updates cost the difference.** The network credits the unused part of the
  previous term; a mid-term update with the same resources is nearly free.
- **Enterprise apps need ArcaneOS nodes.** Only they can decrypt and validate
  a private spec; this server selects one automatically.
`;
