// Sessions outside every project: no folder, so no repository, logo, tasks or orchestrator.
export default {
  sessions: ({ home }) => [
    {
      key: 'shellSuelta',
      n: 14,
      name: 'copia-de-seguridad',
      command: ['/bin/bash'],
      workingDir: home,
      screen: ['$ ./copia.sh', 'copiando 1200 archivos…'],
      lastActivityMinutesAgo: 4,
    },
  ],
};
