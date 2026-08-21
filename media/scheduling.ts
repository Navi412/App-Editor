/**
 * Cede el control a la cola de tareas del navegador sin pasar por
 * setTimeout. Chrome (y otros navegadores) limitan los temporizadores
 * de pestañas en segundo plano a ~1 por segundo pasados unos segundos
 * — en un bucle de sondeo de cientos de iteraciones eso convierte una
 * espera de milisegundos en minutos. Un MessageChannel programa una
 * tarea real sin esa penalización.
 */
export function yieldToTaskQueue(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port2.onmessage = () => resolve();
    channel.port1.postMessage(null);
  });
}
