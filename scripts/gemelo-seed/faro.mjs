// Faro: reservas para restaurantes. The project with everything going on: a running
// orchestrator, a task at work, one waiting for an answer, the queue, a preview and a session
// on an external provider.
export default {
  folder: 'faro-reservas',
  readme: '# Faro\n\nReservas para restaurantes de la costa.\n',
  // A lighthouse beam.
  logo: { background: [18, 52, 86], foreground: [255, 196, 61], shape: (x, y) => y > 0.2 + Math.abs(x - 0.5) * 1.6 && y < 0.82 },
  orchestrator: 'faroBoss',
  worktrees: { pagos: 'pago-con-bizum', turnos: 'turnos-de-cena' },
  previews: [{ id: 'pfaroweb1', port: 'active', title: 'Faro · reservas', session: 'pagos', minutes: 1, pinned: true }],
  sessions: ({ project, wt, uuid }) => [
    {
      key: 'faroBoss',
      n: 1,
      name: 'orquestador-faro',
      command: ['claude'],
      workingDir: project.repo,
      project,
      claude: {
        status: 'busy',
        title: 'Coordinar las reservas de verano',
        user: 'Organiza el trabajo de la temporada de verano.',
        assistant: 'Reparto el trabajo en tres tareas y sigo su avance.',
        tool: { name: 'Bash', input: { command: 'ut task list', description: 'Ver el estado de las tareas' } },
      },
      screen: ['Coordinando las reservas de verano…', '3 tareas en marcha, 1 en cola.'],
    },
    {
      key: 'pagos',
      n: 2,
      name: 'pago-con-bizum',
      command: ['claude'],
      workingDir: wt.pagos,
      project,
      branch: 'ut/pago-con-bizum',
      taskId: uuid(102),
      claude: {
        status: 'busy',
        title: 'Añadir pago con Bizum al checkout',
        user: 'Añade Bizum como método de pago en la reserva.',
        assistant: 'Estoy conectando el formulario con la pasarela de pruebas.',
        tool: { name: 'Edit', input: { file_path: 'src/pagos/bizum.ts' } },
        minutesAgo: 1,
      },
      screen: ['Editando src/pagos/bizum.ts', '✓ 12 pruebas en verde'],
    },
    {
      key: 'turnos',
      n: 3,
      name: 'turnos-de-cena',
      command: ['claude'],
      workingDir: wt.turnos,
      project,
      branch: 'ut/turnos-de-cena',
      taskId: uuid(103),
      // Idle, as after `ut task ask`: a Claude in 'waiting' makes the server rewrite the task's
      // blocker and time a few seconds after start, and the shots came out different every run.
      claude: {
        status: 'idle',
        title: 'Separar los turnos de comida y cena',
        user: 'Separa los turnos de comida y cena en la agenda.',
        assistant: '¿Migro las reservas existentes al turno de cena o las dejo sin turno?',
        minutesAgo: 6,
      },
      screen: ['Falta una decisión antes de migrar los datos.'],
    },
    {
      key: 'proveedor',
      n: 13,
      name: 'resumen-semanal',
      command: ['claude'],
      workingDir: project.repo,
      project,
      modelProvider: { id: 'nimbo', model: 'nimbo-rapido' },
      claude: {
        status: 'busy',
        title: 'Resumen semanal de reservas',
        user: 'Resume las reservas de la semana.',
        assistant: 'Sumando las reservas por día.',
        tool: { name: 'Read', input: { file_path: 'informes/semana-45.csv' } },
      },
      lastActivityMinutesAgo: 2,
    },
  ],
  tasks: ({ project, wt, S, ago, task, worked, closed, doneFiller }) => [
    // Three titles that share their start (2026-11-10: on a phone they read the same three
    // times, cut at «…arreglos claros de…»; ui-layout-audit.mjs, titles-read-the-same).
    task(101, 'queued', 'Revisión 2ª vuelta: arreglos claros del servidor', {
      origin: 'user',
      createdMinutesAgo: 12,
      sinceMinutesAgo: 12,
      extra: { queued: { repoPath: project.repo, since: ago(12), order: 1, limit: 1 } },
    }),
    task(108, 'queued', 'Revisión 2ª vuelta: arreglos claros de agentes e infraestructura', {
      createdMinutesAgo: 9,
      sinceMinutesAgo: 9,
      extra: { queued: { repoPath: project.repo, since: ago(9), order: 2, limit: 1 } },
    }),
    task(116, 'queued', 'Revisión 2ª vuelta: arreglos claros de web, iPhone y scripts', {
      createdMinutesAgo: 8,
      sinceMinutesAgo: 8,
      extra: { queued: { repoPath: project.repo, since: ago(8), order: 3, limit: 1 } },
    }),
    task(102, 'working', 'Añadir pago con Bizum al checkout', {
      ...worked(wt.pagos, S.pagos, ['src/pagos/bizum.ts', 'src/pagos/bizum.test.ts']),
      sinceMinutesAgo: 34,
    }),
    task(103, 'needs_you', 'Separar los turnos de comida y cena', {
      ...worked(wt.turnos, S.turnos, ['src/agenda/turnos.ts']),
      sinceMinutesAgo: 6,
      extra: {
        ...worked(wt.turnos, S.turnos, []).extra,
        blocker: {
          kind: 'question',
          message: '¿Migro las reservas existentes al turno de cena o las dejo sin turno?',
        },
      },
    }),
    task(109, 'merged', 'Corregir el cálculo de la fianza', {
      ...closed(70, { commits: 1, files: 2, insertions: 23, deletions: 9 }),
      files: ['src/pagos/fianza.ts', 'src/pagos/fianza.test.ts'],
    }),
    task(112, 'failed', 'Migrar la base de datos a la versión 3', {
      ...closed(130, { commits: 2, files: 4, insertions: 77, deletions: 12 }, {
        error: 'La comprobación falló: 2 pruebas en rojo en la migración.',
        blocker: {
          kind: 'verify',
          message: 'La comprobación falló: 2 pruebas en rojo en la migración.',
          detail: ['migraciones/v3.test.ts: columnas duplicadas'],
        },
      }),
    }),
    // Its share of a long "Hechas" list (2026-11-09): on a real iPhone the avatars of many merged
    // tasks were painted out of their rows after scrolling; three rows never scrolled far enough.
    // The number is the task's place in that list, which gives it its id, agent, age and size.
    doneFiller(0, 'Paginar el listado de reservas'),
    doneFiller(3, 'Avisar de mesas dobles'),
    doneFiller(6, 'Exportar el cierre de caja'),
    doneFiller(9, 'Reservas de grupos grandes'),
    doneFiller(12, 'Lista de espera automática'),
    doneFiller(15, 'Propinas en el ticket'),
  ],
};
