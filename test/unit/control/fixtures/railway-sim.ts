// A small stateful stand-in for Railway's GraphQL API: just enough of a workspace (projects,
// services, variables, volumes, deployments) for the railway provider's whole lifecycle, answered by
// operation name as the provider sends them (src/control/providers/railway.ts). Deployments
// settle at once and a stop takes effect at once; the timing quirks live in providers-railway.test.ts.

interface Deployment {
  id: string;
  status: string;
  deploymentStopped: boolean;
  statusUpdatedAt: string;
}
interface Service {
  id: string;
  name: string;
  vars: Record<string, string>;
  image: string | null;
  deployments: Deployment[];
  limits: { vCPUs: number; memoryGB: number } | null;
}
interface Project {
  id: string;
  name: string;
  envId: string;
  deletedAt: string | null;
  services: Service[];
  volumes: { serviceId: string; mountPath: string; region: string | null }[];
}

export function railwaySim() {
  const projects: Project[] = [];
  let n = 0;
  const id = (kind: string) => `${kind}-${++n}`;
  const live = () => projects.filter((p) => !p.deletedAt);
  const project = (pid: string) => live().find((p) => p.id === pid);
  const service = (sid: string) => {
    for (const p of live()) {
      const s = p.services.find((x) => x.id === sid);
      if (s) return { p, s };
    }
    return null;
  };
  const deployment = (did: string) => {
    for (const p of live()) for (const s of p.services) {
      const d = s.deployments.find((x) => x.id === did);
      if (d) return { s, d };
    }
    return null;
  };
  const deploy = (s: Service) => {
    for (const d of s.deployments) if (d.status === 'SUCCESS') d.status = 'REMOVED';
    const d: Deployment = { id: id('dep'), status: 'SUCCESS', deploymentStopped: false, statusUpdatedAt: new Date().toISOString() };
    s.deployments.push(d);
    return d;
  };
  const latest = (s: Service) => s.deployments.at(-1) ?? null;
  const data = (d: unknown) => Response.json({ data: d });
  const error = (message: string) => Response.json({ data: null, errors: [{ message }] });

  function answer(op: string, v: Record<string, any>): Response {
    const input = v.input ?? {};
    switch (op) {
      case 'workspaceProjects':
        return data({ workspace: { projects: { edges: projects.map((p) => ({ node: { id: p.id, name: p.name, deletedAt: p.deletedAt } })) } } });
      case 'projectCreate': {
        const p: Project = { id: id('proj'), name: input.name, envId: id('env'), deletedAt: null, services: [], volumes: [] };
        projects.push(p);
        return data({ projectCreate: { id: p.id, environments: { edges: [{ node: { id: p.envId, name: 'production' } }] } } });
      }
      case 'projectLayout': {
        const p = project(v.id);
        if (!p) return data({ project: null });
        return data({
          project: {
            id: p.id, name: p.name,
            environments: { edges: [{ node: { id: p.envId, volumeInstances: { edges: p.volumes.map((x) => ({ node: { serviceId: x.serviceId, mountPath: x.mountPath } })) } } }] },
            services: { edges: p.services.map((s) => ({ node: { id: s.id, name: s.name } })) },
          },
        });
      }
      case 'projectName': {
        const p = project(v.id);
        return p ? data({ project: { name: p.name } }) : error('Project not found');
      }
      case 'serviceCreate': {
        const p = project(input.projectId)!;
        const s: Service = { id: id('svc'), name: input.name, vars: {}, image: null, deployments: [], limits: null };
        p.services.push(s);
        return data({ serviceCreate: { id: s.id, name: s.name } });
      }
      case 'serviceInstanceUpdate': {
        const s = service(v.serviceId)!.s;
        if (input.source?.image) s.image = input.source.image;
        return data({ serviceInstanceUpdate: true });
      }
      case 'serviceInstanceLimitsUpdate': {
        service(input.serviceId)!.s.limits = { vCPUs: input.vCPUs, memoryGB: input.memoryGB };
        return data({ serviceInstanceLimitsUpdate: true });
      }
      case 'volumeCreate': {
        project(input.projectId)!.volumes.push({ serviceId: input.serviceId, mountPath: input.mountPath, region: input.region ?? null });
        return data({ volumeCreate: { id: id('vol') } });
      }
      case 'variableCollectionUpsert': {
        Object.assign(service(input.serviceId)!.s.vars, input.variables);
        return data({ variableCollectionUpsert: true });
      }
      case 'variableDelete': {
        const s = service(input.serviceId)!.s;
        if (!(input.name in s.vars)) return error('Variable not found');
        delete s.vars[input.name];
        return data({ variableDelete: true });
      }
      case 'variables':
        return data({ variables: { ...service(v.serviceId)!.s.vars } });
      case 'serviceInstanceDeployV2':
        return data({ serviceInstanceDeployV2: deploy(service(v.serviceId)!.s).id });
      case 'deploymentStatus':
        return data({ deployment: deployment(v.id) ? { id: v.id, status: deployment(v.id)!.d.status } : null });
      case 'latestDeployment': {
        const d = latest(service(input.serviceId)!.s);
        return data({ deployments: { edges: d ? [{ node: { id: d.id, status: d.status, deploymentStopped: d.deploymentStopped } }] : [] } });
      }
      case 'deploymentStop': {
        const found = deployment(v.id);
        if (!found) return error('Deployment not found');
        found.d.deploymentStopped = true; // Railway: status stays SUCCESS
        return data({ deploymentStop: true });
      }
      case 'deploymentRedeploy': {
        const found = deployment(v.id)!;
        const d = deploy(found.s);
        return data({ deploymentRedeploy: { id: d.id, status: d.status } });
      }
      case 'deploymentStates': {
        const p = project(v.id);
        if (!p) return data({ project: null });
        return data({
          project: {
            environments: {
              edges: [{ node: { id: p.envId, serviceInstances: { edges: p.services.map((s) => ({ node: { serviceId: s.id, latestDeployment: latest(s) && { id: latest(s)!.id, status: latest(s)!.status, deploymentStopped: latest(s)!.deploymentStopped } } })) } } }],
            },
          },
        });
      }
      case 'workspaceStatus':
        return data({
          workspace: {
            projects: {
              edges: live().map((p) => ({
                node: {
                  id: p.id, name: p.name,
                  environments: { edges: [{ node: { id: p.envId, serviceInstances: { edges: p.services.map((s) => ({ node: { serviceId: s.id, serviceName: s.name, latestDeployment: latest(s) && { status: latest(s)!.status, statusUpdatedAt: latest(s)!.statusUpdatedAt, deploymentStopped: latest(s)!.deploymentStopped } } })) } } }] },
                },
              })),
            },
          },
        });
      case 'computeFacts': {
        const p = project(v.id);
        if (!p) return data({ project: null });
        const limits = (sid: string) => {
          const l = service(sid)?.s.limits;
          return l ? { containers: { cpu: l.vCPUs, memoryBytes: Math.round(l.memoryGB * 1024) * 1_000_000 } } : null;
        };
        return data({
          project: {
            name: p.name,
            environments: {
              edges: [{
                node: {
                  id: p.envId,
                  volumeInstances: { edges: p.volumes.map((x) => ({ node: { ...x, sizeMB: 50000, currentSizeMB: 12.5 } })) },
                  serviceInstances: { edges: p.services.map((s) => ({ node: { serviceId: s.id, latestDeployment: latest(s) && { meta: { serviceManifest: { deploy: { multiRegionConfig: { 'europe-west4-drams3a': { numReplicas: 1 } } } } } } } })) },
                },
              }],
            },
          },
          worca: limits(v.worca), broker: limits(v.broker), cloudflared: limits(v.cloudflared),
        });
      }
      case 'projectDelete': {
        const p = project(v.id);
        if (!p) return error('Project not found');
        p.deletedAt = new Date().toISOString();
        return data({ projectDelete: true });
      }
    }
    throw new Error(`railway sim: unexpected operation ${op}`);
  }

  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operationName: string; variables: Record<string, any> };
    return answer(body.operationName, body.variables ?? {});
  };
  return { projects, fetchImpl };
}

/** The stub instance server's admin API (stub/instance.mjs), in memory, for the fake provider. */
export function stubSim() {
  const instances = new Map<string, { state: string; variables: Record<string, unknown> }>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const [, , instanceId, action] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // __admin, instances, id, action
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method === 'POST' && !instanceId) {
      if (instances.has(body.instanceId)) return Response.json({ error: 'exists' }, { status: 409 });
      instances.set(body.instanceId, { state: 'created', variables: {} });
      return Response.json({ ok: true }, { status: 201 });
    }
    const inst = instanceId ? instances.get(instanceId) : undefined;
    if (method === 'DELETE') return instances.delete(instanceId!) ? Response.json({ ok: true }) : Response.json({ error: 'not_found' }, { status: 404 });
    if (!inst) return Response.json({ error: 'not_found' }, { status: 404 });
    if (method === 'GET') return Response.json({ ok: true, state: inst.state });
    if (action === 'variables') Object.assign(inst.variables, body.variables);
    if (action === 'deploy' || action === 'start') inst.state = 'running';
    if (action === 'stop') inst.state = 'stopped';
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { instances, fetchImpl };
}
