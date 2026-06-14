# Domain MCP servers — cluster / GPU / cache / observability

> For a GPU-cluster KV-cache (LMCache/vLLM) optimization workflow. Read-only vs write/destructive flagged.



## CLUSTER

For a GPU-cluster perf engineer optimizing an LLM KV-cache system (LMCache/vLLM-style), the cluster domain has genuinely useful, currently-maintained MCP servers across all four sub-areas, though almost ALL are community/experimental — there is NO official Anthropic or vendor (Slurm SchedMD / Red Hat) reference MCP for SSH, Slurm, or Kubernetes. Anthropic's only maintained reference servers are Everything, Fetch, Filesystem, Git, Memory, Sequential Thinking, Time (none cluster-related). Strongest options: (1) Slurm — IoWarp/CLIO 'clio-kit slurm' (academic project, NSF-backed, 13 documented tools via server.json, runs ON the login node) and yidong72/slurm_mcp (drives a REMOTE Slurm cluster over SSH and uniquely exposes GPU read tools get_gpu_info/get_gpu_availability — best fit for a remote GPU cluster). (2) Kubernetes — containers/kubernetes-mcp-server (Go, native API, --read-only and --disable-destructive flags) and Flux159/mcp-server-kubernetes (~1k stars, ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS env). (3) SSH — several solid community servers (@fangjunjie/ssh-mcp-server with command whitelist/blacklist, tufantunc/ssh-mcp); all execute arbitrary remote commands so are inherently write-capable. (4) Ray — pradeepiyer/ray-mcp exists for Ray clusters (vLLM often uses Ray for tensor/pipeline parallelism). CRITICAL for a shared cluster: submit/cancel/allocate/deallocate job tools and pod delete/exec/scale are WRITE/DESTRUCTIVE and every SSH exec tool can mutate the system — flag these and prefer read-only/non-destructive modes where the server offers them.

### Recommendation
Adopt first: (1) For Slurm — yidong72/slurm_mcp if you drive the cluster remotely from your laptop (it runs over SSH, exposes read-only get_gpu_info/get_gpu_availability that are perfect for finding free GPUs before launching KV-cache benchmarks, and cleanly separates read vs write tools), OR the IoWarp CLIO Slurm MCP (uvx clio-kit slurm) if your agent already runs ON the login node — its 13 tools are documented verbatim in server.json and it's the more actively packaged project. (2) For Kubernetes (since vLLM/LMCache deployments commonly run on k8s) — containers/kubernetes-mcp-server launched with --read-only by default, flipping to writes only when you deliberately need them; its first-class --read-only/--disable-destructive flags make it the safest choice on a shared cluster. Layer in an SSH MCP (@fangjunjie/ssh-mcp-server, with a strict --whitelist of read commands like squeue/sacct/nvidia-smi) only if you need ad-hoc remote shell beyond what the Slurm MCP covers. IMPORTANT shared-cluster guardrails: every job submit/cancel and node allocate/deallocate, every pod delete/exec/scale, and every SSH exec is WRITE/DESTRUCTIVE — gate these in the bridge (allowlist or human-approval) and run the read-only modes by default. On official status: be honest that NONE of these are vendor/Anthropic-official — SchedMD ships no Slurm MCP and Red Hat has not shipped this k8s server as a product; all are community (k8s/SSH/Slurm) or experimental (Ray). Ray MCP is promising for vLLM's Ray-based parallelism but I could not pin its exact run command/tool list to a quoted source, so verify it against the repo before wiring it in.

### Servers

#### CLIO Slurm MCP (IoWarp / iowarp-mcps)  [community/verified-quoted]
- source: pypi: clio-kit (also distributed as iowarp-mcps); repo github.com/iowarp/iowarp-mcps and github.com/iowarp/clio-kit
- transport: stdio | auth: None of its own; inherits the Slurm CLI/credentials of whatever host it runs on. Designed to run ON the cluster login node (shells out to sbatch/squeue/scancel/salloc locally), so place it where you already have valid Slurm access.
- run: uvx clio-kit slurm
- key tools: submit_slurm_job, cancel_slurm_job, submit_array_job, allocate_slurm_nodes, deallocate_slurm_nodes, check_job_status, list_slurm_jobs, get_slurm_info, get_job_details, get_job_output, get_queue_info, get_node_info, get_allocation_status
- read vs write: READ-ONLY (8): check_job_status, list_slurm_jobs, get_slurm_info, get_job_details, get_job_output, get_queue_info, get_node_info, get_allocation_status. WRITE/DESTRUCTIVE (5): submit_slurm_job (creates a job / consumes shared allocation), cancel_slurm_job (kills a running/pending job), submit_array_job (creates many jobs), allocate_slurm_nodes (salloc - holds shared GPU nodes), deallocate_slurm_nodes (scancel of the allocation). No global read-only flag documented; gate the 5 write tools at the harness level on a shared cluster. Tool list taken verbatim from the repo's server.json v2.2.3.
- piConfig: "slurm": { "command": "uvx", "args": ["clio-kit", "slurm"] }  (matches the repo's own .mcp.json {"clio-slurm":{"command":"uvx","args":["clio-kit","slurm"]}}; README also shows older 3-arg form ["clio-kit","mcp-server","slurm"] - prefer the 2-arg form from server.json v2.2.3)
- src: https://github.com/iowarp/iowarp-mcps/blob/main/clio-kit-mcp-servers/slurm/server.json

#### yidong72/slurm_mcp (remote Slurm over SSH, GPU-aware)  [community/verified-quoted]
- source: repo: github.com/yidong72/slurm_mcp (installed from source: pip install -e .)
- transport: stdio (the MCP server itself; it then reaches the cluster over SSH) | auth: SSH to a remote login node - key-based or password, configured via env vars SLURM_SSH_HOST / SLURM_SSH_USER (and key/password). Validates paths against traversal, cleans up idle sessions. This is the one that runs from your laptop and drives the REMOTE cluster, vs CLIO which runs on the login node itself.
- run: slurm-mcp   (console entry point; equivalently: python -m slurm_mcp.server, or python src/slurm_mcp/server.py)
- key tools: submit_job, cancel_job, hold_job, release_job, list_jobs, get_job_details, get_job_history, get_cluster_status, get_partition_info, get_node_info, get_gpu_info, get_gpu_availability, start_interactive_session, end_interactive_session, exec_in_session, read_file, write_file, delete_file, list_directory, find_files, list_container_images, validate_container_image
- read vs write: READ-ONLY: list_jobs, get_job_details, get_job_history, get_cluster_status, get_partition_info, get_node_info, get_gpu_info, get_gpu_availability, read_file, list_directory, find_files, list_container_images, validate_container_image. WRITE/DESTRUCTIVE: submit_job, cancel_job, hold_job, release_job (mutate jobs in the shared queue), start_interactive_session/end_interactive_session/exec_in_session/start_session_from_profile (allocate & run on shared GPU nodes; exec_in_session runs arbitrary commands), write_file, delete_file (mutate the cluster filesystem). save_interactive_profile writes local config. NOTE: get_gpu_info / get_gpu_availability are read-only GPU inventory tools - directly useful for finding free GPUs before launching KV-cache benchmarks.
- piConfig: "slurm": { "command": "slurm-mcp", "env": { "SLURM_SSH_HOST": "login.cluster.example.com", "SLURM_SSH_USER": "username" } }  (README also shows a python src/slurm_mcp/server.py variant)
- src: https://github.com/yidong72/slurm_mcp

#### kubernetes-mcp-server (containers org)  [community/verified-quoted]
- source: npm: kubernetes-mcp-server (Go binary, also published); repo github.com/containers/kubernetes-mcp-server
- transport: stdio (default); also HTTP streamable (/mcp) and SSE (/sse) | auth: Uses your local kubeconfig / current context; no separate auth. Native Go client talking to the Kubernetes API server (does not shell out to kubectl/helm). Promoted in Red Hat Developer content and works with OpenShift, but it is a community project under the 'containers' GitHub org in developer-preview, NOT an officially shipped Red Hat product.
- run: npx -y kubernetes-mcp-server@latest
- key tools: pods_list, pods_get, pods_log, pods_top, resources_list, resources_get, events_list, namespaces_list, nodes_log, nodes_top, configuration_view, helm_list, pods_delete, pods_exec, pods_run, resources_create_or_update, resources_delete, resources_scale, helm_install, helm_uninstall
- read vs write: READ-ONLY: pods_list, pods_get, pods_log, pods_top, resources_list, resources_get, events_list, namespaces_list, nodes_log, nodes_top, configuration_view/configuration_contexts_list, helm_list. WRITE/DESTRUCTIVE: pods_delete, pods_exec (arbitrary command in a container), pods_run, resources_create_or_update, resources_delete (deletes ANY resource), resources_scale, helm_install, helm_uninstall (plus kubevirt/tekton lifecycle toolsets). SAFE MODES: launch with --read-only (blocks all writes) or --disable-destructive (blocks delete/update) - recommended on a shared cluster. Best k8s pick for shared clusters because of these first-class flags.
- piConfig: "kubernetes": { "command": "npx", "args": ["-y", "kubernetes-mcp-server@latest", "--read-only"] }  (drop --read-only only when you intend to mutate the cluster)
- src: https://github.com/containers/kubernetes-mcp-server

#### mcp-server-kubernetes (Flux159)  [community/verified-quoted]
- source: npm: mcp-server-kubernetes; repo github.com/Flux159/mcp-server-kubernetes (~1k stars, ~30 contributors, released Jan 2025)
- transport: stdio (default); also SSE | auth: Wraps local kubectl/helm and uses your kubeconfig (loaded from multiple sources). Masks secrets. Requires kubectl/helm present, unlike the Go server above.
- run: npx mcp-server-kubernetes
- key tools: kubectl_get, kubectl_describe, kubectl_logs, explain_resource, list_api_resources, ping, kubectl_create, kubectl_apply, kubectl_patch, kubectl_scale, kubectl_rollout, kubectl_delete, install_helm_chart, uninstall_helm_chart, cleanup, port_forward, stop_port_forward, kubectl_generic
- read vs write: READ-ONLY: kubectl_get, kubectl_describe, kubectl_logs, explain_resource, list_api_resources, ping. WRITE: kubectl_create, kubectl_apply, kubectl_patch, kubectl_scale, kubectl_rollout, kubectl_context, install_helm_chart, upgrade_helm_chart. DESTRUCTIVE: kubectl_delete, uninstall_helm_chart, cleanup, cleanup_pods, node_management, kubectl_generic (escape hatch - runs arbitrary kubectl). SAFE MODE: set env ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS=true to disable kubectl_delete, uninstall_helm_chart, cleanup, cleanup_pods, node_management, kubectl_generic. More popular than the Go server but wraps the CLI and only offers a non-destructive toggle (no full read-only that blocks create/apply).
- piConfig: "kubernetes": { "command": "npx", "args": ["mcp-server-kubernetes"], "env": { "ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS": "true" } }
- src: https://github.com/Flux159/mcp-server-kubernetes

#### ssh-mcp-server (@fangjunjie / classfang)  [community/verified-quoted]
- source: npm: @fangjunjie/ssh-mcp-server; repo github.com/classfang/ssh-mcp-server
- transport: stdio | auth: SSH password, private key, key+passphrase, ~/.ssh/config reuse, keyboard-interactive 2FA/MFA (SSH_MCP_2FA_CODE), SOCKS proxy. Supports exec mode (default) and shell mode for bastion/jump hosts.
- run: npx -y @fangjunjie/ssh-mcp-server
- key tools: execute-command, upload, download, list-servers
- read vs write: execute-command is INHERENTLY WRITE-CAPABLE (runs any shell command on the remote login node - can rm/kill/flush a cache); the README recommends --whitelist to restrict commands and a --blacklist for patterns like ^rm.*,^shutdown.*,^reboot.*. download and list-servers are READ-ONLY; upload is WRITE (modifies remote filesystem). On a shared cluster, run with an explicit command whitelist. Richest auth (2FA + jump host) of the SSH options, which matters for university HPC login nodes.
- piConfig: "ssh": { "command": "npx", "args": ["-y", "@fangjunjie/ssh-mcp-server", "--host", "login.cluster.edu", "--username", "alex", "--whitelist", "^squeue.*,^sacct.*,^nvidia-smi.*"] }
- src: https://github.com/classfang/ssh-mcp-server

#### ssh-mcp (tufantunc)  [community/verified-quoted]
- source: npm: ssh-mcp; repo github.com/tufantunc/ssh-mcp
- transport: stdio | auth: SSH password (--password) or key (--key), optional --sudoPassword/--suPassword, --timeout, --maxChars output cap.
- run: npx ssh-mcp -y -- --host=1.2.3.4 --port=22 --user=root --key=path/to/key
- key tools: exec, sudo-exec
- read vs write: BOTH WRITE/DESTRUCTIVE: exec runs an arbitrary shell command on the remote host; sudo-exec runs it with sudo elevation. No read-only restriction and no whitelist - anything from squeue to rm -rf. Treat the whole server as a write surface; not ideal for an unattended agent on a shared cluster. Simpler than @fangjunjie's but lacks whitelisting and adds sudo-exec (higher blast radius).
- piConfig: "ssh-mcp": { "command": "npx", "args": ["ssh-mcp", "-y", "--", "--host=login.cluster.edu", "--port=22", "--user=alex", "--key=/Users/alex/.ssh/id_ed25519", "--timeout=30000"] }
- src: https://github.com/tufantunc/ssh-mcp

#### ray-mcp (pradeepiyer)  [experimental/uncertain]
- source: repo: github.com/pradeepiyer/ray-mcp
- transport: stdio | auth: Connects to a Ray cluster (head node address); relies on Ray's own job submission client.
- run: (installed from the repo; exact entry-point command not verified verbatim from source in this pass - confirm against the repo README before wiring in)
- key tools: cluster_status, submit_job
- read vs write: READ-ONLY: cluster_status (and other monitoring). WRITE/DESTRUCTIVE: starting/stopping Ray head & worker nodes, submit_job, and stop/delete job operations mutate a shared Ray cluster. Treat cluster start/stop and job submit/stop as destructive. Only cluster_status and submit_job were confirmed by name; full tool surface and exact run command not pinned to a quoted source, hence uncertain. Relevant because vLLM frequently uses Ray for tensor/pipeline-parallel serving.
- piConfig: Not wired verbatim from source - confirm the launch command and tool list from the repo before adding.
- src: https://github.com/pradeepiyer/ray-mcp


## GPU-PERF

This is a genuinely thin ecosystem. There is no official NVIDIA MCP server for GPU monitoring or profiling — everything found is community/experimental, mostly low-star, single-author repos. For this KV-cache/vLLM performance workflow on a shared cluster, the realistically useful, install-today options are: (1) a couple of small pynvml/nvidia-smi telemetry wrappers exposing read-only NVML metrics (util/mem/temp/power/processes), and (2) the nsys (Nsight Systems) MCP server which actually EXECUTES workloads under the profiler. CRITICAL SAFETY NOTES for a shared cluster: almost all telemetry tools are read-only, but two found servers carry real risk — amanzainal/mcp-gpu exposes set_power_limit (runs `nvidia-smi -pl`, changes GPU power cap, needs root), and the nsys server's profile_binary RUNS an arbitrary binary under the profiler (consumes GPU, executes code). Nsight Compute (ncu) has NO dedicated MCP server. The widely-listed Nsight Systems MCP (KorovkoAlexander/nsys_profiler_mcp) is cataloged on PulseMCP/Glama/lobehub but its GitHub source now 404s (removed/private), so it is not installable from source right now despite directory listings claiming 'active'. py-spy/perf have no purpose-built MCP; the only generic profiler MCP (Sarthak160/Profiler-MCP) is Go/Python/Java pprof+cProfile+JFR and not GPU-aware. Nsight Graphics MCP exists but is for D3D12/Vulkan rendering, not CUDA compute — irrelevant here. Recommendation: adopt a read-only pynvml wrapper now for live GPU state; use the nsys server only if you can vet/build it, and gate any power-limit/profile-execute tool behind explicit approval on shared hardware.

### Recommendation
Adopt FIRST: (1) a read-only NVML telemetry wrapper for live GPU state — custom-build-robots/mcp-gpu-monitor (pynvml, 5 read-only tools: util/mem/thermals/power) or amanzainal/mcp-gpu run WITHOUT exposing set_power_limit (use MCP_GPU_MOCK or just don't grant that tool). These give the agent instant, safe answers to 'what's GPU 3 doing / who's holding VRAM' without shelling out to nvidia-smi. Both are tiny single-author community repos, so vet the ~100-line source before trusting it on a shared box. (2) For actual kernel-level profiling of the KV-cache paths, the nsys (Nsight Systems) MCP is the only domain-fit option — but treat it as experimental and gated: its profile_binary EXECUTES a workload under nsys, and its public GitHub source currently 404s, so build/vet it yourself before use. Honest gaps to flag to the user: there is NO official NVIDIA GPU-monitoring or profiling MCP; NO dedicated Nsight Compute (ncu) MCP; NO purpose-built py-spy or perf MCP. On a SHARED cluster, the only two tools that change state are amanzainal/mcp-gpu's set_power_limit (nvidia-smi -pl, root, affects co-tenants) and nsys profile_binary (runs code/consumes GPU) — keep both behind explicit human approval and never auto-allow them.

### Servers

#### custom-build-robots/mcp-gpu-monitor  [community/verified-quoted]
- source: repo: github.com/custom-build-robots/mcp-gpu-monitor (gpu_monitor.py)
- transport: sse | auth: none (no auth on the SSE endpoint; bound to 0.0.0.0:8765 by default — keep behind firewall/LAN)
- run: python gpu_monitor.py   # serves SSE at http://<host>:8765/sse ; install: uv venv --python 3.12 --seed .venv && source .venv/bin/activate && uv pip install -r requirements.txt
- key tools: get_gpu_count, get_gpu_info, get_gpu_utilization, get_gpu_memory, get_gpu_thermals
- read vs write: ALL 5 tools are read-only NVML reads (pynvml: nvmlDeviceGetUtilizationRates / GetMemoryInfo / GetTemperature / GetPowerUsage). No tool changes GPU state. Note it binds 0.0.0.0:8765 by default — on a shared/cluster node restrict the bind address/firewall.
- piConfig: Bridge to an HTTP/SSE endpoint; not a stdio command. mcpServers entry: "mcp-gpu-monitor": { "transport": "sse", "url": "http://<host>:8765/sse" }
- src: https://github.com/custom-build-robots/mcp-gpu-monitor

#### amanzainal/mcp-gpu  [community/verified-quoted]
- source: repo: github.com/amanzainal/mcp-gpu (uv package 'mcp-gpu')
- transport: stdio | auth: none for telemetry; set_power_limit needs OS root/sudo to actually apply
- run: uv run mcp-gpu            # real telemetry
uv run mcp-gpu --mock     # synthetic / no-GPU mock  (install: git clone … && cd mcp-gpu && uv sync)
- key tools: list_gpus, gpu_processes, gpu_summary, set_power_limit
- read vs write: READ-ONLY: list_gpus (index/name/mem/util/temp), gpu_processes (per-PID GPU mem), gpu_summary (text overview). WRITE/DESTRUCTIVE: set_power_limit(index, watts) runs `nvidia-smi -i <index> -pl <watts>` to change the GPU power cap — requires root/sudo, alters hardware behavior, and on a SHARED cluster affects all tenants of that GPU. Has a --mock / MCP_GPU_MOCK=1 mode that logs the command without executing. Do NOT enable set_power_limit on shared hardware without explicit approval.
- piConfig: "mcp-gpu": { "command": "uv", "args": ["run", "--directory", "/abs/path/to/mcp-gpu", "mcp-gpu"], "env": { "MCP_GPU_MOCK": "0" } }   // set MCP_GPU_MOCK=1 to neuter set_power_limit while testing
- src: https://github.com/amanzainal/mcp-gpu

#### KorovkoAlexander/nsys_profiler_mcp (nsys-mcp / Nsight Systems Profiler)  [experimental/uncertain]
- source: pip (editable, 'nsys_mcp'); cataloged on PulseMCP/Glama/lobehub — BUT GitHub source github.com/KorovkoAlexander/nsys_profiler_mcp currently returns 404 (removed/private)
- transport: stdio | auth: none (local stdio); profile_binary executes whatever binary path it is given
- run: python -m nsys_mcp.server   # install: pip install -e .  (needs `nsys` on PATH, Python 3.10+) — CAVEAT: source repo 404s as of 2026-06, so 'pip install -e .' has no public source to clone right now
- key tools: check_nsys, profile_binary, load_report, list_reports, get_event_summary, get_kernel_stats, get_nvtx_stats, get_memcpy_stats, build_interval_tree, query_interval_tree
- read vs write: WRITE/EXECUTES: profile_binary runs an arbitrary executable under `nsys` (Nsight Systems) — it EXECUTES code and consumes the GPU; on a shared node this launches a real workload. READ-ONLY: check_nsys (verifies nsys in PATH), load_report/list_reports, get_event_summary, get_kernel_stats (per-kernel duration + grid/block/smem/regs), get_nvtx_stats, get_memcpy_stats (HtoD/DtoH/DtoD bandwidth), build_interval_tree/query_interval_tree (parse/analyze existing .nsys-rep reports). Most-valuable read path for KV-cache work: profile once, then query kernel/memcpy/NVTX stats. Requires NVIDIA Nsight Systems in PATH and Python 3.10+.
- piConfig: "nsys-profiler": { "command": "python", "args": ["-m", "nsys_mcp.server"] }   // only works if you obtain the package; verify source before trusting profile_binary
- src: https://www.pulsemcp.com/servers/gh-korovkoalexander-nsys-profiler

#### SikamikanikoBG/homelab-monitor (built-in read-only MCP)  [community/verified-quoted]
- source: docker (compose); github.com/SikamikanikoBG/homelab-monitor
- transport: http | auth: none on the MCP HTTP endpoint — keep behind LAN/VPN/firewall (README explicitly warns broad host footprint)
- run: claude mcp add --transport http homelab http://YOUR-HUB:9810/mcp   # dashboard on :9800, MCP rides along on :9810 (ENABLE_MCP=1 default); deployed via the project's docker-compose
- key tools: get_gpu, get_ai_models, get_snapshot, get_history, get_events, get_containers, list_hosts
- read vs write: ALL 12 tools are READ-ONLY by design (README: 'there are no write tools'). Relevant ones: get_gpu (util/VRAM/power/temp + which process/container holds the card), get_ai_models (loaded models incl. vLLM/Ollama/llama.cpp, their VRAM and who is calling them), get_events (OOM kills). Strengths for vLLM: it probes model-server APIs and attributes VRAM to the holding process. Caveat: it's a multi-host HOMELAB dashboard (runs with broad host access — root mount, read-only Docker socket, D-Bus); heavier and more oriented to fleets than to a single profiling box. Toggle MCP off with ENABLE_MCP=0.
- piConfig: "homelab": { "transport": "http", "url": "http://YOUR-HUB:9810/mcp" }
- src: https://github.com/SikamikanikoBG/homelab-monitor

#### mitulgarg/env-doctor (CUDA/GPU environment doctor, MCP mode)  [community/likely]
- source: pypi: pip install env-doctor (binary env-doctor-mcp)
- transport: stdio | auth: none (local stdio)
- run: env-doctor-mcp   # install: pip install env-doctor
- key tools: env-doctor-mcp (11 diagnostic tools: check GPU environment, CUDA/driver compatibility, 'can I run model X on my GPU', validate Dockerfile for GPU issues)
- read vs write: The MCP server is READ-ONLY/diagnostic (reports compatibility, capacity, env issues; does not modify the system). IMPORTANT distinction: the separate CLI (e.g. `env-doctor cuda-install --run`) CAN install/modify the CUDA environment — those write ops are NOT part of the MCP surface, so as long as you wire only env-doctor-mcp it cannot mutate the box. Not a live telemetry/profiler — it's for diagnosing driver/CUDA/VRAM-fit problems. Highest-traction repo found (~160 stars, actively maintained).
- piConfig: "env-doctor": { "command": "env-doctor-mcp" }
- src: https://github.com/mitulgarg/env-doctor

#### Sarthak160/Profiler-MCP (pprof inspector — generic, NOT GPU-aware)  [community/verified-quoted]
- source: repo: github.com/Sarthak160/Profiler-MCP (Go binary)
- transport: stdio | auth: none (local stdio); open_interactive_ui exposes a localhost web UI
- run: go build -o pprof-mcp-server main.go   # then run the binary directly (clone first: git clone … && cd Profiler-MCP)
- key tools: analyze_profile, open_interactive_ui
- read vs write: READ: analyze_profile parses an EXISTING cpu/heap profile (Go pprof .prof) and reports hot paths. EXECUTE/LAUNCH (effectively write): open_interactive_ui spins up a background pprof web server (binds a local port); the Python path RUNS your script under cProfile and the Java path RUNS the .jar under JFR for ~60s — i.e. it executes code. This is CPU/heap profiling for Go/Python/Java; it does NOT understand CUDA/GPU kernels, so it's only marginally relevant (host-side Python hot paths) to a KV-cache GPU workload. Listed for completeness because it's the only general profiler MCP that's actually maintained.
- piConfig: "pprof-inspector": { "command": "/abs/path/to/Profiler-MCP/pprof-mcp-server" }
- src: https://github.com/Sarthak160/Profiler-MCP

#### elliotttate/nsight-graphics-mcp (OUT OF SCOPE — graphics, not compute)  [experimental/verified-quoted]
- source: repo: github.com/elliotttate/nsight-graphics-mcp (pip install -e .)
- transport: stdio | auth: none (local stdio)
- run: nsight-graphics-mcp   # (Windows-centric; pip install -e ".[dev]")
- key tools: (252 tools across capture/replay/shader-debug/frame-debugger categories)
- read vs write: Mixed read (query/search/list captures, parse SQLite event index) and write/execute (launch captures, run replays, build/run C++ repro projects, install/uninstall NGFX layers). FLAGGED ONLY TO WARN OFF: this wraps NVIDIA Nsight GRAPHICS (D3D12/Vulkan/OpenGL rendering, shader/pixel debugging) — it is explicitly NOT for CUDA compute profiling and is irrelevant to an LLM-inference/KV-cache workflow. Do not adopt for this use case.
- piConfig: Not recommended for this workflow (graphics-only).
- src: https://github.com/elliotttate/nsight-graphics-mcp


## CACHE-DATA

s

### Recommendation
r

### Servers

#### Redis MCP Server (official)  [official/verified-quoted]
- source: github redis/mcp-redis ; PyPI redis-mcp-server ; Docker mcp/redis
- transport: stdio | auth: --url redis://host:port/db or rediss:// TLS; or env REDIS_HOST/PORT/DB/USERNAME/PWD, REDIS_SSL, REDIS_CLUSTER_MODE. Redis or Valkey LMCache backends.
- run: uvx --from redis-mcp-server@latest redis-mcp-server --url redis://localhost:6379/0
- key tools: info, dbsize, client_list, type, scan_keys, get, hget, hgetall, get_indexes, get_index_info, vector_search_hash, hybrid_search, set, hset, hdel, json_set, delete, expire, rename
- read vs write: READ-ONLY: info, dbsize, client_list, type, scan_keys, get, hget, hgetall, get_indexes, get_index_info, vector_search_hash, hybrid_search, json_get. WRITE/DESTRUCTIVE: delete, expire(eviction), rename, set, hset, hdel, list/stream/json writes, publish, create_vector_index_hash. NO FLUSHDB/FLUSHALL tool.
- piConfig: redis: uvx [--from, redis-mcp-server@latest, redis-mcp-server, --url, redis://localhost:6379/0]
- src: https://github.com/redis/mcp-redis


## OBSERVABILITY

For this KV-cache / vLLM perf-optimization workflow on a shared GPU cluster, the observability + experiment-tracking domain is well-served by MCP. vLLM exports Prometheus metrics (throughput, cache-hit/usage, GPU KV-cache utilization), so a Prometheus MCP is the highest-leverage pick for watching a live run via PromQL. Findings: (1) Prometheus has NO official (prometheus.io) MCP server — only community ones; the most popular and safest is pab1it0/prometheus-mcp-server (468 stars, v1.6.1 May 2026), which is 100% read-only. The alternative tjhop/prometheus-mcp-server is more powerful (full HTTP API in Go) but ships genuinely DESTRUCTIVE TSDB-admin tools (delete_series, clean_tombstones, snapshot) plus a config reload tool — these are gated behind a flag but must be flagged for a shared cluster. (2) Grafana's mcp-grafana IS official (grafana/mcp-grafana) and is the broadest tool: it can run PromQL directly (query_prometheus), read dashboards/alerts/incidents, AND has write tools (update_dashboard, create_annotation, create_incident, alerting create/update/delete). (3) Weights & Biases ships an OFFICIAL MCP (wandb/wandb-mcp-server) with a hosted remote endpoint — mostly read-only run/sweep/metric/trace querying, with two write tools (create_wandb_report_tool, log_analysis_to_wandb). (4) MLflow has NO official MCP — the leading community option is kkruglik/mlflow-mcp; it is feature-rich but exposes many destructive registry/run tools (delete_run, delete_experiment, delete_registered_model, transition_model_version_stage, register_model). All four are stdio-capable and bridge cleanly into pi's MCP bridge. Auth is uniformly via env vars (API keys / tokens). Caveat on confidence: tool lists were extracted from each project's README via a summarizing fetch, so individual tool names are 'likely' verbatim unless I could quote them directly; run commands are quoted verbatim from official docs/READMEs.

### Recommendation
Adopt pab1it0/prometheus-mcp-server FIRST. It is the single best pick for watching a live cluster optimization run: vLLM exposes its KV-cache and throughput metrics as Prometheus metrics, so PromQL via execute_query/execute_range_query lets the agent track cache-hit rate, GPU KV-cache utilization, tokens/s, and queue depth in real time — and it is 100% read-only, which is exactly what you want on shared infra (no risk of mutating the TSDB or another team's data). Pair it SECOND with the OFFICIAL grafana/mcp-grafana, which also runs PromQL (query_prometheus) but additionally reads existing dashboards/alerts/incidents and can render panels — start it with write tools (update_dashboard, create_annotation, create_incident, alerting create/update/delete) disabled. Caveats: avoid tjhop's Prometheus server unless you specifically need its full-API surface, and if you use it NEVER pass --dangerous.enable-tsdb-admin-tools (it unlocks delete_series/clean_tombstones/snapshot, plus it always carries a config reload tool). For experiment tracking, pick based on which tracker the team actually uses: W&B users get the official wandb/wandb-mcp-server (mostly read-only, safe; only two additive write tools); MLflow has NO official MCP, so kkruglik/mlflow-mcp is the pragmatic community choice but ships many destructive registry/run delete + stage-transition tools — gate or run it read-only on a shared registry. Net: Prometheus (read-only) + Grafana (read-mode) cover the live-optimization observability loop; add the matching tracker MCP only for post-run analysis.

### Servers

#### pab1it0/prometheus-mcp-server  [community/verified-quoted]
- source: docker: ghcr.io/pab1it0/prometheus-mcp-server:latest ; pypi: prometheus-mcp-server
- transport: stdio | auth: Env vars: PROMETHEUS_URL (required). Optional PROMETHEUS_USERNAME/PROMETHEUS_PASSWORD (basic auth), PROMETHEUS_TOKEN (bearer), PROMETHEUS_CLIENT_CERT/PROMETHEUS_CLIENT_KEY (mTLS). Transport overridable via PROMETHEUS_MCP_SERVER_TRANSPORT.
- run: docker run -i --rm -e PROMETHEUS_URL="http://your-prometheus:9090" ghcr.io/pab1it0/prometheus-mcp-server:latest
- key tools: execute_query, execute_range_query, list_metrics, get_metric_metadata, get_targets, health_check
- read vs write: ALL READ-ONLY. execute_query (PromQL instant), execute_range_query (PromQL range / time-series), list_metrics, get_metric_metadata, get_targets (scrape targets), health_check are all query/discovery only. No write or destructive tools exist. Safe on a shared cluster.
- piConfig: "prometheus": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "PROMETHEUS_URL", "ghcr.io/pab1it0/prometheus-mcp-server:latest"], "env": { "PROMETHEUS_URL": "http://your-prometheus:9090" } }
- src: https://github.com/pab1it0/prometheus-mcp-server

#### tjhop/prometheus-mcp-server  [community/verified-quoted]
- source: docker: ghcr.io/tjhop/prometheus-mcp-server:latest (also single Go binary / Helm chart oci://ghcr.io/tjhop/charts/prometheus-mcp-server)
- transport: stdio | auth: Flag/env: --prometheus.url (or PROMETHEUS_MCP_SERVER_PROMETHEUS_URL). Upstream Prometheus auth via --http.config file; MCP endpoint secured with --web.config.file (basic auth + TLS).
- run: docker run --rm -i ghcr.io/tjhop/prometheus-mcp-server:latest --prometheus.url "https://$yourPrometheus:9090"
- key tools: query, range_query, metric_metadata, label_names, label_values, series, list_alerts, list_rules, list_targets, config, reload, delete_series, clean_tombstones, snapshot
- read vs write: READ-ONLY (vast majority): query, range_query, exemplar_query, metric_metadata, label_names, label_values, series, list_alerts, list_rules, list_targets, targets_metadata, alertmanagers, build_info, runtime_info, flags, config, healthy, ready, tsdb_stats, wal_replay_status, plus docs_list/docs_read/docs_search. WRITE/OPERATIONAL: reload (reloads Prometheus config — affects the running server). DESTRUCTIVE (gated behind --dangerous.enable-tsdb-admin-tools, OFF by default): delete_series, clean_tombstones, snapshot. On a shared cluster, do NOT pass the --dangerous flag.
- piConfig: "prometheus": { "command": "docker", "args": ["run", "--rm", "-i", "ghcr.io/tjhop/prometheus-mcp-server:latest", "--prometheus.url", "https://your-prometheus:9090"] }  // do NOT add --dangerous.enable-tsdb-admin-tools on shared infra
- src: https://github.com/tjhop/prometheus-mcp-server

#### grafana/mcp-grafana (OFFICIAL)  [official/verified-quoted]
- source: docker: grafana/mcp-grafana ; go install github.com/grafana/mcp-grafana/cmd/mcp-grafana@latest ; uvx mcp-grafana
- transport: stdio | auth: Env vars: GRAFANA_URL (required); GRAFANA_SERVICE_ACCOUNT_TOKEN (preferred) or deprecated GRAFANA_API_KEY; optional GRAFANA_USERNAME/GRAFANA_PASSWORD, GRAFANA_ORG_ID. Categories toggle via --enabled-tools / --disable-<category> flags.
- run: docker run --rm -i -e GRAFANA_URL=http://localhost:3000 -e GRAFANA_SERVICE_ACCOUNT_TOKEN=<token> grafana/mcp-grafana -t stdio
- key tools: query_prometheus, query_prometheus_histogram, list_prometheus_metric_names, search_dashboards, get_dashboard_by_uid, query_loki_logs, list_incidents, get_annotations, update_dashboard, create_annotation, create_incident, alerting_manage_rules
- read vs write: READ-ONLY: query_prometheus, query_prometheus_histogram, list_prometheus_metric_names, list_prometheus_metric_metadata, list_prometheus_label_names/values, search_dashboards, get_dashboard_by_uid, get_dashboard_summary/property/panel_queries, list_datasources, get_datasource, query_loki_logs + loki label/stats tools, get_annotations, get_annotation_tags, list_incidents, get_incident, OnCall/Sift/admin listing tools, get_panel_image, generate_deeplink. WRITE/DESTRUCTIVE: update_dashboard, patch_dashboard (modify dashboards), create_annotation, update_annotation, create_incident, add_activity_to_incident, and alerting_manage_rules in create/update/DELETE modes. On a shared Grafana, prefer running with only read tools enabled.
- piConfig: "grafana": { "command": "docker", "args": ["run", "--rm", "-i", "-e", "GRAFANA_URL", "-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN", "grafana/mcp-grafana", "-t", "stdio"], "env": { "GRAFANA_URL": "http://localhost:3000", "GRAFANA_SERVICE_ACCOUNT_TOKEN": "<token>" } }
- src: https://github.com/grafana/mcp-grafana

#### wandb/wandb-mcp-server (OFFICIAL W&B)  [official/verified-quoted]
- source: git: git+https://github.com/wandb/wandb-mcp-server (uvx) ; pypi: wandb-mcp-server ; hosted remote: https://mcp.withwandb.com/mcp
- transport: stdio (local uvx) or http (local --transport http, or hosted remote endpoint) | auth: Env var WANDB_API_KEY (required); WANDB_BASE_URL for dedicated/on-prem. Hosted endpoint uses Authorization: Bearer <WANDB_API_KEY>. Requires Python 3.11+ for local install.
- run: uvx --from git+https://github.com/wandb/wandb-mcp-server wandb_mcp_server
- key tools: query_wandb_tool, get_run_history_tool, query_weave_traces_tool, count_weave_traces_tool, query_wandb_entity_projects, list_artifact_versions_tool, get_artifact_details_tool, search_wandb_docs_tool, create_wandb_report_tool, log_analysis_to_wandb
- read vs write: READ-ONLY (12 of 14): query_wandb_tool (runs/metrics/experiments), get_run_history_tool (sampled time-series metrics), query_weave_traces_tool, count_weave_traces_tool, infer_trace_schema_tool, query_wandb_entity_projects, list_registries_tool, list_registry_collections_tool, list_artifact_versions_tool, get_artifact_details_tool, compare_artifact_versions_tool, search_wandb_docs_tool. WRITE (2): create_wandb_report_tool (creates a W&B Report with charts/panels) and log_analysis_to_wandb (logs analysis metrics to W&B as a run). Both writes are additive (no delete), low risk on a shared workspace but still mutate W&B state.
- piConfig: "wandb": { "command": "uvx", "args": ["--from", "git+https://github.com/wandb/wandb-mcp-server", "wandb_mcp_server"], "env": { "WANDB_API_KEY": "<your-key>" } }   // or hosted: claude mcp add --transport http wandb https://mcp.withwandb.com/mcp --header "Authorization: Bearer <YOUR-WANDB-API-KEY>"
- src: https://github.com/wandb/wandb-mcp-server

#### kkruglik/mlflow-mcp (community; no official MLflow MCP exists)  [community/verified-quoted]
- source: pypi: mlflow-mcp (uvx mlflow-mcp) ; repo: github.com/kkruglik/mlflow-mcp
- transport: stdio | auth: Env vars: MLFLOW_TRACKING_URI (required). Optional MLFLOW_TRACKING_USERNAME/MLFLOW_TRACKING_PASSWORD (HTTP basic) or MLFLOW_TRACKING_TOKEN (bearer/Databricks). Requires Python >=3.10, MLflow >=3.4.0.
- run: uvx mlflow-mcp
- key tools: query_runs, get_run, get_run_metrics, get_best_run, compare_runs, search_experiments, get_experiment_metrics, get_registered_models, delete_run, register_model, transition_model_version_stage
- read vs write: READ-ONLY: get_experiments, search_experiments, get_experiment_by_name, get_experiment_metrics/params/tags, get_runs, get_run, get_parent_run, query_runs, search_runs_by_tags, get_best_run, compare_runs, get_run_metrics, get_run_metric, get_run_artifacts, get_run_artifact, get_artifact_content, search_logged_models, get_logged_model, get_registered_models/model, get_model_versions/version, get_model_version_by_alias, get_latest_versions, health. WRITE/DESTRUCTIVE: delete_experiment, delete_run, delete_model_version, delete_registered_model, delete_model_alias (DESTRUCTIVE); register_model, update_model_version, copy_model_version, transition_model_version_stage, set_model_alias, set_experiment_tag, set_run_tag, set_registered_model_tag (mutating). Significant blast radius on a shared MLflow registry — restrict or run read-only.
- piConfig: "mlflow": { "command": "uvx", "args": ["mlflow-mcp"], "env": { "MLFLOW_TRACKING_URI": "http://your-mlflow:5000" } }
- src: https://github.com/kkruglik/mlflow-mcp