// IA soberana: a long name on a long branch, with a running orchestrator (2026-11-10: on a real
// iPhone the project header cut names to "UNT…" while "Orquestador" and "+ Tarea" kept their words).
export default {
  folder: 'ia-soberana-espana',
  branch: 'integracion/modelos-abiertos-2026',
  readme: '# IA soberana\n\nCatálogo inventado de modelos abiertos.\n',
  logo: { background: [170, 21, 27], foreground: [241, 191, 0], shape: (_x, y) => y > 0.3 && y < 0.7 },
  orchestrator: 'soberanaBoss',
  sessions: ({ project }) => [
    {
      key: 'soberanaBoss',
      n: 16,
      name: 'orquestador-ia-soberana',
      command: ['claude'],
      workingDir: project.repo,
      project,
      mainBranch: project.branch,
      claude: {
        status: 'busy',
        title: 'Evaluar los modelos abiertos del catálogo',
        user: 'Evalúa los modelos abiertos y prepara la comparativa.',
        assistant: 'Empiezo por las licencias y sigo con las pruebas de castellano.',
        tool: { name: 'Bash', input: { command: 'ut task list', description: 'Ver el estado de las tareas' } },
        minutesAgo: 3,
      },
      screen: ['Evaluando el catálogo de modelos…', '1 tarea en cola.'],
    },
  ],
  tasks: ({ project, task, closed }) => [
    // Closed: a queued one would start for real, with nothing else holding the project's limit.
    task(114, 'failed', 'Comparar las licencias de los modelos abiertos', {
      ...closed(95, { commits: 1, files: 2, insertions: 31, deletions: 4 }, {
        baseBranch: project.branch,
        error: 'La comprobación falló: falta la licencia de dos modelos.',
        blocker: { kind: 'verify', message: 'La comprobación falló: falta la licencia de dos modelos.' },
      }),
    }),
  ],
};
