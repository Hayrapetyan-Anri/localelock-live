import {
  BASELINE_RUN_ID,
  HERO_DIRECTOR_ACTOR,
  HERO_LOCALE,
  HERO_VENDOR,
  HERO_VERSION,
  LATEST_SOURCE_REVISION,
  SYNTHETIC_DISCLAIMER,
  TITLE_ID,
  TITLE_NAME,
  type Finding,
  type GlossaryTerm,
  type LocalizationEvent,
  type ReleaseRun,
  type RunPhaseRecord,
  type SourceTargetPair,
  type SubtitleCue,
} from './constants.js';
import { seededEventId } from '../db/ids.js';
import {
  buildSemanticFinding,
  evaluateDeterministicFindings,
  localRows,
  placeholderSemanticReview,
  semanticReviewInput,
  sortFindings,
  type SemanticCandidateRow,
} from './rules.js';

const SCRIPT: Array<[string, string]> = [
  ['Depot log, night shift, 23:40.', 'Bitácora de la cochera, turno de noche, 23:40.'],
  ['Line 4 is still out on the hill.', 'La línea 4 sigue afuera, en la colina.'],
  ['Dispatch, this is Teo. Do you copy?', 'Despacho, aquí Teo. ¿Me copias?'],
  ['I copy. Where are you, Teo?', 'Te copio. ¿Dónde estás, Teo?'],
  ['Top of Wren Street. The rails are icing.', 'Arriba de la calle Wren. Los rieles se congelan.'],
  ['Slow down through the curve.', 'Baja la velocidad en la curva.'],
  ["I've done this curve a thousand times.", 'He pasado esta curva mil veces.'],
  ['Not with ice on it.', 'No con hielo encima.'],
  ['Fine. Slowing down.', 'Está bien. Bajo la velocidad.'],
  ['The depot wants the last run cancelled.', 'La cochera quiere cancelar el último viaje.'],
  ["Cancelled? It's the last tram of the night.", '¿Cancelar? Es el último tranvía de la noche.'],
  ['I know what it is.', 'Sé lo que es.'],
  ['There are people waiting at the hospital stop.', 'Hay gente esperando en la parada del hospital.'],
  ['Three, maybe four.', 'Tres, tal vez cuatro.'],
  ['The board says the storm peaks at one.', 'El tablero dice que la tormenta llega al máximo a la una.'],
  ['Then we have an hour.', 'Entonces tenemos una hora.'],
  ['We have forty minutes, Teo.', 'Tenemos cuarenta minutos, Teo.'],
  ["Keep the heaters on. I'm coming in.", 'Deja la calefacción encendida. Voy para allá.'],
  ['Copy. Platform two is clear.', 'Copiado. El andén dos está libre.'],
  ['Mara, the depot called again.', 'Mara, la cochera llamó otra vez.'],
  ['What did they say?', '¿Qué dijeron?'],
  ['They want the manifest signed before midnight.', 'Quieren el manifiesto firmado antes de medianoche.'],
  ['Who signs a manifest at midnight?', '¿Quién firma un manifiesto a medianoche?'],
  ['Whoever is on the night shift.', 'Quien esté en el turno de noche.'],
  ['That would be me.', 'Esa sería yo.'],
  ["Then it's you.", 'Entonces eres tú.'],
  ['Give me the clipboard.', 'Dame la tabla.'],
  ['Passenger count, cargo, crew.', 'Pasajeros, carga, tripulación.'],
  ["Cargo? It's a tram.", '¿Carga? Es un tranvía.'],
  ['One crate for the hospital. Medicine.', 'Una caja para el hospital. Medicinas.'],
  ['Since when do we carry medicine?', '¿Desde cuándo llevamos medicinas?'],
  ['Since the road closed at six.', 'Desde que cerraron la carretera a las seis.'],
  ['So the tram is the only way up.', 'Entonces el tranvía es la única vía.'],
  ['Tonight, yes.', 'Esta noche, sí.'],
  ['Teo Aldana, you are cleared to platform two.', 'Teo Aldana, autorizado al andén dos.'],
  ['Cleared. Rolling in.', 'Autorizado. Entrando.'],
  ["Ilse, you can't be back here.", 'Ilse, no puedes estar aquí atrás.'],
  ['The gate was open.', 'La reja estaba abierta.'],
  ["The gate is always open.\nThat's not permission.", 'La reja siempre está abierta.\nEso no es permiso.'],
  ['I need to get to the hospital.', 'Necesito llegar al hospital.'],
  ['The last tram leaves at midnight.', 'El último tranvía sale a medianoche.'],
  ['If it leaves at all.', 'Si es que sale.'],
  ['It will leave. Sit by the heater.', 'Va a salir. Siéntate junto al calefactor.'],
  ['Is that the driver?', '¿Ese es el conductor?'],
  ["That's Teo. He's the best we have.", 'Es Teo. Es el mejor que tenemos.'],
  ['He looks tired.', 'Se ve cansado.'],
  ["We're all tired. It's the night shift.", 'Todos estamos cansados. Es el turno de noche.'],
  ['Dispatch to the depot. Manifest is ready.', 'Despacho a la cochera. El manifiesto está listo.'],
  ['Who is signing?', '¿Quién firma?'],
  ['Mara Voss, night dispatch.', 'Mara Voss, despacho nocturno.'],
  ['Send the copy over.', 'Manda la copia.'],
  ['Sending.', 'Enviando.'],
  ['Received. Hold for the depot chief.', 'Recibido. Espera al jefe de la cochera.'],
  ["We don't have time to hold.", 'No tenemos tiempo para esperar.'],
  ['Hold anyway.', 'Espera de todos modos.'],
  ['Who signed it in the end?', '¿Quién lo firmó al final?'],
  ['Mara Voss signed the manifest herself.', 'Maria Voss firmó el manifiesto ella misma.'],
  ["Then it's on her.", 'Entonces es responsabilidad de ella.'],
  ["It's on all of us.", 'Es de todos nosotros.'],
  ["Teo, what's your reading on the brakes?", 'Teo, ¿cómo están los frenos?'],
  ["Soft. They've been soft since Tuesday.", 'Blandos. Están blandos desde el martes.'],
  ["You didn't report that.", 'No lo reportaste.'],
  ['I reported it twice.', 'Lo reporté dos veces.'],
  ["It's not in the log.", 'No está en la bitácora.'],
  ['Then the log is wrong.', 'Entonces la bitácora está mal.'],
  ['The log is never wrong, Teo.', 'La bitácora nunca está mal, Teo.'],
  ['Tonight it is.', 'Esta noche sí.'],
  ['Ilse, how old is the patient?', 'Ilse, ¿qué edad tiene el paciente?'],
  ["Seven. She's my sister.", 'Siete. Es mi hermana.'],
  ['And the medicine is for her?', '¿Y la medicina es para ella?'],
  ["It's for the whole ward.", 'Es para toda la sala.'],
  ['How did you get down the hill?', '¿Cómo bajaste la colina?'],
  ['I walked. Along the rails.', 'Caminé. Por los rieles.'],
  ['In this weather?', '¿Con este clima?'],
  ['There was no other way.', 'No había otra manera.'],
  ['Sit down before you fall down.', 'Siéntate antes de que te caigas.'],
  ['Depot chief on the line.', 'El jefe de la cochera en la línea.'],
  ['Put him through.', 'Pásamelo.'],
  ['Voss, this is Brenner. Cancel the run.', 'Voss, habla Brenner. Cancele el viaje.'],
  ['Sir, we have a medical crate on board.', 'Señor, tenemos una caja médica a bordo.'],
  ["I don't care what's on board.", 'No me importa qué hay a bordo.'],
  ["The road is closed.\nWe're the only line open.", 'La carretera está cerrada.\nSomos la única línea abierta.'],
  ['And if that tram slides off the hill?', '¿Y si ese tranvía se sale de la colina?'],
  ["Then I'll have signed for it.", 'Entonces yo habré firmado por eso.'],
  ['You already did.', 'Ya lo hiciste.'],
  ['Yes. I did.', 'Sí. Lo hice.'],
  ['You have until midnight. Not a minute more.', 'Tiene hasta medianoche. Ni un minuto más.'],
  ['Understood.', 'Entendido.'],
  ['Teo, did you hear that?', 'Teo, ¿oíste eso?'],
  ['Every word.', 'Cada palabra.'],
  ['Can you make the hill?', '¿Puedes subir la colina?'],
  ['With soft brakes and ice? Maybe.', '¿Con frenos blandos y hielo? Tal vez.'],
  ['I need better than maybe.', 'Necesito algo mejor que tal vez.'],
  ['Then you need a different driver.', 'Entonces necesitas otro conductor.'],
  ['There is no different driver.', 'No hay otro conductor.'],
  ['Then maybe is what you get.', 'Entonces tal vez es lo que hay.'],
  ['Load the crate. Strap it twice.', 'Sube la caja. Amárrala dos veces.'],
  ['Ilse, you ride up front with Teo.', 'Ilse, tú vas adelante con Teo.'],
  ['Why up front?', '¿Por qué adelante?'],
  ['Because I want him to see you.', 'Porque quiero que él te vea.'],
  ["So he remembers who's on board.", 'Para que recuerde quién va a bordo.'],
  ['Radio check. Dispatch to tram.', 'Prueba de radio. Despacho a tranvía.'],
  ['Tram to dispatch. Loud and clear.', 'Tranvía a despacho. Fuerte y claro.'],
  ['Doors closing.', 'Cerrando puertas.'],
  ['Platform two, departure.', 'Andén dos, salida.'],
  ['Take the curve at ten.', 'Toma la curva a diez.'],
  ['Ten is crawling.', 'A diez es arrastrarse.'],
  ['Ten is alive.', 'A diez es seguir vivo.'],
  ['Copy. Ten.', 'Copiado. Diez.'],
  ['Mara, the depot is still on the other line.', 'Mara, la cochera sigue en la otra línea.'],
  ['Let them wait.', 'Que esperen.'],
  ["They're asking for the manifest number.", 'Piden el número del manifiesto.'],
  ["Give it to them. It's mine anyway.", 'Dáselo. De todos modos es mío.'],
  ['Ilse, are you warm enough?', 'Ilse, ¿tienes suficiente calor?'],
  ["I'm fine. How long to the top?", 'Estoy bien. ¿Cuánto falta hasta arriba?'],
  ['Eleven minutes on a dry night.', 'Once minutos en una noche seca.'],
  ['Tonight, longer.', 'Esta noche, más.'],
  ["And if the tram doesn't come back?", '¿Y si el tranvía no vuelve?'],
  ['It always comes back. Tonight too.', 'Siempre vuelve. Esta noche también.'],
  ["Dispatch, we're past the first switch.", 'Despacho, pasamos el primer cambio.'],
  ['Copy. Wind is picking up on the ridge.', 'Copiado. El viento aumenta en la cresta.'],
  ['I can feel it.', 'Lo siento.'],
  ['Keep your speed steady.', 'Mantén la velocidad estable.'],
  ['Steady is all I have.', 'Estable es todo lo que tengo.'],
  ['Ilse, tell me about your sister.', 'Ilse, háblame de tu hermana.'],
  ['She likes trams.', 'Le gustan los tranvías.'],
  ['Smart kid.', 'Niña lista.'],
  ['She counts them from the window.', 'Los cuenta desde la ventana.'],
  ["Then she's counting this one.", 'Entonces está contando este.'],
  ["She'll count it twice tonight.", 'Esta noche lo contará dos veces.'],
  ['Up and back.', 'Subida y regreso.'],
  ['Up and back.', 'Subida y regreso.'],
  ['Mara, Brenner wants to know if you sent the copy.', 'Mara, Brenner quiere saber si mandaste la copia.'],
  ['I sent it an hour ago.', 'La mandé hace una hora.'],
  ['He says he never got it.', 'Dice que nunca la recibió.'],
  ['Then send it again.', 'Entonces mándala otra vez.'],
  ['Which copy? The signed one?', '¿Cuál copia? ¿La firmada?'],
  ['The signed one. Only the signed one.', 'La firmada. Solo la firmada.'],
  ['Second switch. Holding at ten.', 'Segundo cambio. Manteniendo a diez.'],
  ['Brakes?', '¿Frenos?'],
  ['Still soft. Still there.', 'Aún blandos. Aún ahí.'],
  ["There's a light on the track.", 'Hay una luz en la vía.'],
  ['What kind of light?', '¿Qué clase de luz?'],
  ["A lantern. Someone's walking.", 'Una linterna. Alguien camina.'],
  ['On the rails? Tonight?', '¿Por los rieles? ¿Esta noche?'],
  ["That's how I came down.", 'Así bajé yo.'],
  ['Slow to five. Sound the bell.', 'Baja a cinco. Toca la campana.'],
  ['Bell sounding.', 'Campana sonando.'],
  ["They're moving off. It's an old man.", 'Se aparta. Es un hombre mayor.'],
  ['Does he need a ride?', '¿Necesita que lo llevemos?'],
  ["He's waving us on.", 'Nos hace señas de seguir.'],
  ['Then we go on.', 'Entonces seguimos.'],
  ["Dispatch, we're clear of the walker.", 'Despacho, ya pasamos al caminante.'],
  ['Copy. Time check: eleven fifty-two.', 'Copiado. Hora: once cincuenta y dos.'],
  ['Eight minutes.', 'Ocho minutos.'],
  ['Seven, by my watch.', 'Siete, según mi reloj.'],
  ['Your watch runs fast.', 'Tu reloj se adelanta.'],
  ['So do I.', 'Yo también.'],
  ['Third switch coming up.', 'Se acerca el tercer cambio.'],
  ["That's the frozen one.", 'Ese es el congelado.'],
  ['I know which one it is.', 'Sé cuál es.'],
  ['Then take it easy.', 'Entonces con calma.'],
  ['Ilse, hold on to the rail.', 'Ilse, agárrate del pasamanos.'],
  ["I'm holding.", 'Estoy agarrada.'],
  ['Here it comes.', 'Ahí viene.'],
  ['Come on. Come on.', 'Vamos. Vamos.'],
  ["We're through.", 'Pasamos.'],
  ['Told you it comes back.', 'Te dije que vuelve.'],
  ['You said it always comes back.', 'Dijiste que siempre vuelve.'],
  ['Same thing.', 'Es lo mismo.'],
  ['Mara, the depot says the storm turned.', 'Mara, la cochera dice que la tormenta giró.'],
  ['Turned where?', '¿Giró hacia dónde?'],
  ['Toward the ridge. Faster than they thought.', 'Hacia la cresta. Más rápido de lo que creían.'],
  ['How much faster?', '¿Cuánto más rápido?'],
  ["It's there now.", 'Ya está ahí.'],
  ['Teo, do you read?', 'Teo, ¿me recibes?'],
  ['Barely. The wind is eating the signal.', 'Apenas. El viento se come la señal.'],
  ['The storm is on the ridge.', 'La tormenta está en la cresta.'],
  ['I can see that.', 'Ya lo veo.'],
  ['Can you turn around?', '¿Puedes dar la vuelta?'],
  ['Not on the hill. Not with this ice.', 'En la colina no. No con este hielo.'],
  ['Then you go up.', 'Entonces subes.'],
  ['Then I go up.', 'Entonces subo.'],
  ['How far to the hospital stop?', '¿Cuánto falta para la parada del hospital?'],
  ['Two hundred meters.', 'Doscientos metros.'],
  ['Two hundred meters of ice.', 'Doscientos metros de hielo.'],
  ["I've done worse.", 'He hecho cosas peores.'],
  ['When?', '¿Cuándo?'],
  ["Never. But I've said it before.", 'Nunca. Pero ya lo había dicho.'],
  ['Mara Voss, this is Brenner. Answer me.', 'Mara Voss, habla Brenner. Respóndame.'],
  ["I'm here.", 'Aquí estoy.'],
  ['Bring that tram back down.', 'Traiga ese tranvía de vuelta.'],
  ["It can't turn on the hill.", 'No puede girar en la colina.'],
  ['Then stop it where it is.', 'Entonces deténgalo donde está.'],
  ['On a frozen slope?\nWith a child on board?', '¿En una pendiente helada?\n¿Con una niña a bordo?'],
  ["That's an order, Voss.", 'Es una orden, Voss.'],
  ['I signed the manifest, sir.', 'Yo firmé el manifiesto, señor.'],
  ['The tram goes up.', 'El tranvía sube.'],
  ['Ilse, can you see the lights?', 'Ilse, ¿ves las luces?'],
  ['I see them.', 'Las veo.'],
  ["That's the hospital.", 'Ese es el hospital.'],
  ["That's where she counts from.", 'Desde ahí es donde cuenta.'],
  ["Then let's give her something to count.", 'Entonces démosle algo que contar.'],
  ['If the last tram leaves without us, no one will know where.', 'Si el último tranvía se va sin nosotros, nadie sabrá dónde.'],
  ["Nobody's leaving without you.", 'Nadie se va sin ti.'],
  ['Fifty meters.', 'Cincuenta metros.'],
  ['Brakes?', '¿Frenos?'],
  ["Don't ask me about the brakes.", 'No me preguntes por los frenos.'],
  ['Twenty meters.', 'Veinte metros.'],
  ['Hospital stop. Stopping.', 'Parada del hospital. Deteniendo.'],
  ["We're stopped.", 'Estamos detenidos.'],
  ['Dispatch, tram at the hospital stop.', 'Despacho, tranvía en la parada del hospital.'],
  ['Copy. Time: eleven fifty-nine.', 'Copiado. Hora: once cincuenta y nueve.'],
  ['One minute early.', 'Un minuto antes.'],
  ['Your watch runs fast.', 'Tu reloj se adelanta.'],
  ['Doors open. Ilse, go.', 'Puertas abiertas. Ilse, ve.'],
  ['The crate?', '¿La caja?'],
  ['The nurses have it. Go.', 'Las enfermeras la tienen. Ve.'],
  ['Thank you, Teo.', 'Gracias, Teo.'],
  ['Thank Mara. She signed for it.', 'Agradécele a Mara. Ella firmó.'],
  ["Mara, they're inside.", 'Mara, ya están adentro.'],
  ['All of them?', '¿Todos?'],
  ['All of them. And the crate.', 'Todos. Y la caja.'],
  ["Then it's done.", 'Entonces está hecho.'],
  ['Now the hard part.', 'Ahora la parte difícil.'],
  ['Coming back down.', 'Bajar de regreso.'],
  ['Brenner is asking for the report.', 'Brenner pide el informe.'],
  ['The report can wait.', 'El informe puede esperar.'],
  ['He says now.', 'Dice que ahora.'],
  ['Mara, the depot line is open. Your call.', 'Mara, la cochera está en línea. Tú decides.'],
  ['Do not send it yet.', 'Envialo ahora.'],
  ['Why not?', '¿Por qué no?'],
  ["Because Teo isn't down yet.", 'Porque Teo no ha bajado.'],
  ['Teo, do you read?', 'Teo, ¿me recibes?'],
  ['I read you.', 'Te recibo.'],
  ['Bring it home.', 'Tráelo a casa.'],
  ['Coming home.', 'Voy a casa.'],
  ['Slowly.', 'Despacio.'],
  ['Always.', 'Siempre.'],
  ['The last tram, back at the depot. 00:31.', 'El último tranvía, en la cochera. 00:31.'],
];

export const HERO_CUE_COUNT = 240;
if (SCRIPT.length !== HERO_CUE_COUNT) throw new Error(`hero script must have ${HERO_CUE_COUNT} cues, has ${SCRIPT.length}`);

export const HERO_R2_POLISHED: Record<number, { r1: string }> = {
  12: { r1: 'I know.' },
  40: { r1: 'I have to reach the hospital.' },
  88: { r1: 'Yes, sir.' },
  133: { r1: 'Mara, Brenner is asking about the copy.' },
  189: { r1: 'Never. But it sounds good.' },
};
export const HERO_R3_CUE_ID = 231;
export const HERO_R3_PREVIOUS_SOURCE = 'Send it now.';
export const HERO_R3_SOURCE = 'Do not send it yet.';

export const HERO_ANCHORS = {
  57: { start_ms: 171_000, end_ms: 173_800 },
  118: { start_ms: 349_000, end_ms: 352_420 },
  119: { start_ms: 352_000, end_ms: 354_600 },
  204: { start_ms: 611_200, end_ms: 613_600 },
  231: { start_ms: 700_400, end_ms: 702_600 },
} as const;
export const HERO_CUE_IDS = [57, 118, 204, 231] as const;

export const HERO_GLOSSARY: Array<Omit<GlossaryTerm, 'title_id' | 'locale'>> = [
  { source_term: 'Mara Voss', approved_target_term: 'Mara Voss', note: 'Character name - never localized' },
  { source_term: 'Teo Aldana', approved_target_term: 'Teo Aldana', note: 'Character name - never localized' },
  { source_term: 'the depot', approved_target_term: 'la cochera', note: 'Tram depot, not "el depósito"' },
  { source_term: 'dispatch', approved_target_term: 'despacho', note: 'Dispatch office / radio call sign' },
  { source_term: 'last tram', approved_target_term: 'último tranvía', note: 'Title phrase' },
  { source_term: 'night shift', approved_target_term: 'turno de noche', note: '' },
];

const GAP_MS = 160;
const STEP_MS = 40;
const TIMELINE_END_MS = 719_800;

function cp(s: string): number {
  return Array.from(s.replace(/\n/g, '')).length;
}

interface Timing {
  start_ms: number;
  end_ms: number;
}

function roundStep(ms: number): number {
  return Math.round(ms / STEP_MS) * STEP_MS;
}

function fillSegment(out: Map<number, Timing>, from: number, to: number, segStart: number, segEnd: number): void {
  const ids: number[] = [];
  for (let id = from; id <= to; id++) ids.push(id);
  const weights = ids.map((id) => Math.max(12, cp(SCRIPT[id - 1][0]), cp(SCRIPT[id - 1][1])));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = segEnd - segStart;
  let cursor = segStart;
  ids.forEach((id, i) => {
    const slot = (weights[i] / total) * span;
    const start = roundStep(cursor);
    const end = roundStep(cursor + slot - GAP_MS);
    out.set(id, { start_ms: start, end_ms: end });
    cursor += slot;
  });
}

function buildTimings(): Map<number, Timing> {
  const t = new Map<number, Timing>();
  for (const [id, a] of Object.entries(HERO_ANCHORS)) t.set(Number(id), { ...a });
  fillSegment(t, 1, 56, 800, HERO_ANCHORS[57].start_ms - GAP_MS);
  fillSegment(t, 58, 117, HERO_ANCHORS[57].end_ms + GAP_MS, HERO_ANCHORS[118].start_ms - GAP_MS);
  fillSegment(t, 120, 203, HERO_ANCHORS[119].end_ms + GAP_MS, HERO_ANCHORS[204].start_ms - GAP_MS);
  fillSegment(t, 205, 230, 615_000, HERO_ANCHORS[231].start_ms - GAP_MS);
  fillSegment(t, 232, 240, HERO_ANCHORS[231].end_ms + GAP_MS, TIMELINE_END_MS);
  return t;
}

const TIMINGS = buildTimings();

export function heroTiming(cue_id: number): Timing {
  const t = TIMINGS.get(cue_id);
  if (!t) throw new Error(`no timing for cue ${cue_id}`);
  return { ...t };
}

export type SourceRevision = 'r1' | 'r2' | 'r3';
export const SOURCE_REVISIONS: SourceRevision[] = ['r1', 'r2', 'r3'];

export function heroSourceText(cue_id: number, revision: SourceRevision): string {
  if (cue_id === HERO_R3_CUE_ID) return revision === 'r3' ? HERO_R3_SOURCE : HERO_R3_PREVIOUS_SOURCE;
  if (revision === 'r1' && HERO_R2_POLISHED[cue_id]) return HERO_R2_POLISHED[cue_id].r1;
  return SCRIPT[cue_id - 1][0];
}

export function heroSourceRevisionOf(cue_id: number): SourceRevision {
  if (cue_id === HERO_R3_CUE_ID) return 'r3';
  if (HERO_R2_POLISHED[cue_id]) return 'r2';
  return 'r1';
}

export function heroTranslatedAgainst(version: number): SourceRevision {
  return version <= 3 ? 'r1' : 'r2';
}

export function heroTargetTextV7(cue_id: number): string {
  return SCRIPT[cue_id - 1][1];
}

const LEGACY_VARIANTS: Record<number, Record<number, string>> = {
  1: { 4: 'Copiado. ¿Dónde estás, Teo?', 21: '¿Qué te dijeron?', 90: 'Cada una de las palabras.', 122: 'Lo puedo sentir.', 170: 'Da lo mismo.', 219: 'Gracias, Teo. De verdad.' },
  2: { 4: 'Copiado. ¿Dónde estás, Teo?', 21: '¿Qué te dijeron?', 90: 'Cada una de las palabras.', 122: 'Lo puedo sentir.', 170: 'Da lo mismo.' },
  3: { 21: '¿Qué te dijeron?', 90: 'Cada una de las palabras.', 122: 'Lo puedo sentir.', 170: 'Da lo mismo.' },
  4: { 21: '¿Qué te dijeron?', 122: 'Lo puedo sentir.', 170: 'Da lo mismo.' },
  5: { 122: 'Lo puedo sentir.', 170: 'Da lo mismo.' },
  6: { 170: 'Da lo mismo.' },
};

export function heroTargetText(cue_id: number, version: number): string {
  if (version >= HERO_VERSION) return heroTargetTextV7(cue_id);
  return LEGACY_VARIANTS[version]?.[cue_id] ?? heroTargetTextV7(cue_id);
}

function legacyTiming(cue_id: number, version: number): Timing {
  const t = heroTiming(cue_id);
  if (version <= 3 && cue_id === 30) return { start_ms: t.start_ms, end_ms: t.end_ms + 400 };
  if (version <= 5 && cue_id === 150) return { start_ms: t.start_ms, end_ms: t.start_ms + 900 };
  return t;
}

export function heroCuesForVersion(version: number): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (let id = 1; id <= HERO_CUE_COUNT; id++) {
    const t = version >= HERO_VERSION ? heroTiming(id) : legacyTiming(id, version);
    cues.push({
      title_id: TITLE_ID,
      locale: HERO_LOCALE,
      cue_id: id,
      version,
      start_ms: t.start_ms,
      end_ms: t.end_ms,
      text: heroTargetText(id, version),
      source_revision: heroTranslatedAgainst(version),
    });
  }
  return cues;
}

export function heroPairsForVersion(version: number): SourceTargetPair[] {
  const pairs: SourceTargetPair[] = [];
  for (let id = 1; id <= HERO_CUE_COUNT; id++) {
    const rev = heroSourceRevisionOf(id);
    const pair: SourceTargetPair = {
      title_id: TITLE_ID,
      cue_id: id,
      source_text: heroSourceText(id, LATEST_SOURCE_REVISION),
      target_text: heroTargetText(id, version),
      locale: HERO_LOCALE,
      source_revision: rev,
      target_version: version,
    };
    if (id === HERO_R3_CUE_ID) pair.previous_source_text = HERO_R3_PREVIOUS_SOURCE;
    else if (HERO_R2_POLISHED[id]) pair.previous_source_text = HERO_R2_POLISHED[id].r1;
    pairs.push(pair);
  }
  return pairs;
}

export function heroGlossary(): GlossaryTerm[] {
  return HERO_GLOSSARY.map((g) => ({ title_id: TITLE_ID, locale: HERO_LOCALE, ...g }));
}

export function heroSourceCues(revision: SourceRevision = LATEST_SOURCE_REVISION): Array<{ cue_id: number; start_ms: number; end_ms: number; text: string }> {
  const out = [];
  for (let id = 1; id <= HERO_CUE_COUNT; id++) out.push({ cue_id: id, ...heroTiming(id), text: heroSourceText(id, revision) });
  return out;
}

const H = 3_600_000;
const D = 24 * H;
const MIN = 60_000;

export function heroReleaseAt(T0: Date): Date {
  return new Date(T0.getTime() + 2 * H);
}

export function heroEvents(T0: Date): LocalizationEvent[] {
  const at = (deltaMs: number) => new Date(T0.getTime() + deltaMs).toISOString();
  const release_at = heroReleaseAt(T0).toISOString();
  const ev = (key: string, e: Omit<LocalizationEvent, 'event_id' | 'title_id' | 'locale'>): LocalizationEvent => ({
    event_id: seededEventId(`hero_${key}`),
    title_id: TITLE_ID,
    locale: HERO_LOCALE,
    ...e,
  });
  const deliveries = [-18 * D, -15 * D, -12 * D, -7 * D, -4 * D, -2 * D];
  const events: LocalizationEvent[] = [
    ev('script_locked_r1', {
      event_type: 'script_locked',
      source_revision: 'r1',
      target_version: null,
      occurred_at: at(-21 * D),
      summary: 'English script locked (r1) - 240 cues, 12 min',
      actor: 'Post-production (fictional)',
    }),
  ];
  deliveries.forEach((delta, i) => {
    const v = i + 1;
    events.push(
      ev(`vendor_delivery_v${v}`, {
        event_type: 'vendor_delivery',
        source_revision: heroTranslatedAgainst(v),
        target_version: v,
        occurred_at: at(delta),
        summary: `Spanish v${v} delivered - translated against source ${heroTranslatedAgainst(v)}`,
        actor: HERO_VENDOR,
      }),
    );
  });
  events.push(
    ev('source_revision_r2', {
      event_type: 'source_revision',
      source_revision: 'r2',
      target_version: null,
      occurred_at: at(-9 * D),
      summary: `Source r2: minor line polish on ${Object.keys(HERO_R2_POLISHED).length} cues (${Object.keys(HERO_R2_POLISHED).join(', ')})`,
      actor: 'Script supervisor (fictional)',
    }),
    ev('release_scheduled', {
      event_type: 'release_scheduled',
      source_revision: 'r2',
      target_version: null,
      occurred_at: at(-1 * D),
      summary: `Release window opens at ${release_at}`,
      actor: 'Release planning (fictional)',
    }),
    ev('source_revision_r3', {
      event_type: 'source_revision',
      source_revision: 'r3',
      target_version: null,
      occurred_at: at(-(3 * H + 10 * MIN)),
      summary: `Line 231 changed: "${HERO_R3_PREVIOUS_SOURCE}" → "${HERO_R3_SOURCE}"`,
      actor: HERO_DIRECTOR_ACTOR,
    }),
    ev('vendor_delivery_v7', {
      event_type: 'vendor_delivery',
      source_revision: 'r2',
      target_version: HERO_VERSION,
      occurred_at: at(-(2 * H + 5 * MIN)),
      summary: 'Spanish v7 delivered - translated against source r2',
      actor: HERO_VENDOR,
    }),
  );
  return events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

export const HERO_INCOMING_EVENT_ID = seededEventId('hero_vendor_delivery_v7');
export const HERO_R3_EVENT_ID = seededEventId('hero_source_revision_r3');

export interface BaselineRun {
  run: Omit<ReleaseRun, 'findings'>;
  findings: Finding[];
}

export function baselineRun(T0: Date, opts: { model: string; backend: 'vertex-ai' | 'gemini-api'; synthetic_rows_total: number }): BaselineRun {
  const started = new Date(T0.getTime() - (2 * H + 4 * MIN));
  const cues = heroCuesForVersion(HERO_VERSION);
  const pairs = heroPairsForVersion(HERO_VERSION);
  const glossary = heroGlossary();
  const created_at = new Date(started.getTime() + 2_400).toISOString();
  const ctx = {
    run_id: BASELINE_RUN_ID,
    title_id: TITLE_ID,
    locale: HERO_LOCALE,
    version: HERO_VERSION,
    created_at,
    newId: (rule: string, cue_id: number) => `f_baseline_v7_${rule.toLowerCase()}_${cue_id}`,
  };
  const findings = evaluateDeterministicFindings(localRows(cues, pairs, glossary), cues, ctx);
  const candidates: SemanticCandidateRow[] = pairs
    .filter((p) => p.source_revision === LATEST_SOURCE_REVISION)
    .map((p) => ({
      cue_id: p.cue_id,
      source_text: p.source_text,
      target_text: p.target_text,
      previous_source_text: p.previous_source_text ?? null,
      source_revision: p.source_revision,
      target_version: p.target_version,
    }));
  for (const c of candidates) {
    const cue = cues.find((x) => x.cue_id === c.cue_id)!;
    const review = placeholderSemanticReview(semanticReviewInput(c, HERO_LOCALE), opts.model, opts.backend, created_at);
    const f = buildSemanticFinding(c, cue, review, LATEST_SOURCE_REVISION, ctx, {
      source: 'deterministic_query',
      headline: `Cue ${c.cue_id} changed in source ${LATEST_SOURCE_REVISION} after translation - semantic review required`,
      severity: 'high',
      is_blocker: true,
      fallback_target_text: null,
    });
    if (f) findings.push({ ...f, detail: `Source r3 changed cue ${c.cue_id} from "${c.previous_source_text}" to "${c.source_text}" after v${c.target_version} was translated against r2; the delivered target "${c.target_text}" has not been semantically reviewed.` });
  }
  const sorted = sortFindings(findings);
  const blockers = sorted.filter((f) => f.is_blocker).length;

  const phaseNames = ['event_received', 'querying_clickhouse', 'deterministic_qc', 'gemini_semantic_review', 'producer_decision'] as const;
  let cursor = started.getTime();
  const phases: RunPhaseRecord[] = phaseNames.map((phase) => {
    const s = cursor;
    const notes: Record<(typeof phaseNames)[number], string> = {
      event_received: `Intake baseline for vendor_delivery v${HERO_VERSION} (seeded)`,
      querying_clickhouse: 'Intake baseline - seeded state, not a measured run; no MCP calls were made',
      deterministic_qc: `${sorted.length - candidates.length} deterministic findings`,
      gemini_semantic_review: `${candidates.length} candidate pair(s) flagged for semantic review - pending live Gemini review`,
      producer_decision: `HELD - ${blockers} blockers (seeded intake state)`,
    };
    return { phase, started_at: new Date(s).toISOString(), ended_at: new Date(s).toISOString(), duration_ms: null, note: notes[phase] };
  });
  const ended = new Date(cursor);
  const run: Omit<ReleaseRun, 'findings'> = {
    run_id: BASELINE_RUN_ID,
    title_id: TITLE_ID,
    locale: HERO_LOCALE,
    version: HERO_VERSION,
    trigger: 'vendor_delivery',
    trigger_event_id: HERO_INCOMING_EVENT_ID,
    parent_run_id: null,
    recheck_run_id: null,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended.getTime() - started.getTime(),
    phase: 'complete',
    phases,
    release_state: blockers > 0 ? 'HELD' : 'READY',
    blocker_count: blockers,
    finding_count: sorted.length,
    trace: [],
    agent: null,
    semantic_review: null,
    semantic_candidates: candidates.length,
    approval: null,
    error: null,
    origin: 'seed_baseline',
    dataset: { synthetic_rows_total: opts.synthetic_rows_total, disclaimer: SYNTHETIC_DISCLAIMER },
  };
  return { run, findings: sorted };
}

export const HERO_TITLE = { title_id: TITLE_ID, name: TITLE_NAME };
