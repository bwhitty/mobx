import {IObservable, IDepTreeNode, propagateReadiness, propagateStaleness, addObserver, removeObserver} from "./observable";
import {quickDiff, invariant} from "../utils/utils";
import {reportTransition} from "../api/extras";
import {globalState} from "./globalstate";

/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode, IObservable {
	observing: IObservable[];
	staleObservers: IDerivation[];
	observers: IDerivation[];
	dependencyStaleCount: number;
	dependencyChangeCount: number;
	onDependenciesReady(): boolean;
}

export function isComputingDerivation() {
	return globalState.derivationStack.length > 0;
}

export function checkIfStateModificationsAreAllowed() {
	invariant(globalState.allowStateChanges, `It is not allowed to change the state when a computed value is being evaluated. Use 'autorun' to create reactive functions with side-effects. Or use 'extras.allowStateChanges(true, block)' to supress this message.`);
}

/**
 * Notify a derivation that one of the values it is observing has become stale
 */
export function notifyDependencyStale(derivation: IDerivation) {
	if (++derivation.dependencyStaleCount === 1) {
		reportTransition(derivation, "STALE");
		propagateStaleness(derivation);
	}
}

/**
 * Notify a derivation that one of the values it is observing has become stable again.
 * If all observed values are stable and at least one of them has changed, the derivation
 * will be scheduled for re-evaluation.
 */
export function notifyDependencyReady(derivation: IDerivation, dependencyDidChange: boolean) {
	invariant(derivation.dependencyStaleCount > 0, "unexpected ready notification");
	if (dependencyDidChange)
		derivation.dependencyChangeCount += 1;
	if (--derivation.dependencyStaleCount === 0) {
		// all dependencies are ready
		if (derivation.dependencyChangeCount > 0) {
			// did any of the observables really change?
			derivation.dependencyChangeCount = 0;
			reportTransition(derivation, "PENDING");
			const changed = derivation.onDependenciesReady();
			propagateReadiness(derivation, changed);
		} else {
			// we're done, but didn't change, lets make sure verybody knows..
			reportTransition(derivation, "READY", false);
			propagateReadiness(derivation, false);
		}
	}
}

/**
 * Executes the provided function `f` and tracks which observables are being accessed.
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * as observer of any of the accessed observables.
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T) {
	const prevObserving = derivation.observing;
	derivation.observing = [];
	globalState.derivationStack.push(derivation);
	const result = f();
	bindDependencies(derivation, prevObserving);
	return result;
}

function bindDependencies(derivation: IDerivation, prevObserving: IObservable[]) {
	globalState.derivationStack.length -= 1;

	let [added, removed] = quickDiff(derivation.observing, prevObserving);

	for (let i = 0, l = added.length; i < l; i++) {
		let dependency = added[i];
		// only check for cycles on new dependencies, existing dependencies cannot cause a cycle..
		invariant(!findCycle(derivation, dependency), `Cycle detected`, derivation);
		addObserver(added[i], derivation);
	}

	// remove observers after adding them, so that they don't go in lazy mode to early
	for (let i = 0, l = removed.length; i < l; i++)
		removeObserver(removed[i], derivation);
}

/**
 * Find out whether the dependency tree of this derivation contains a cycle, as would be the case in a 
 * computation like `a = a * 2`
 */
function findCycle(needle: IDerivation, node: IObservable): boolean {
	const obs = node.observing;
	if (obs === undefined)
		return false;
	if (obs.indexOf(node) !== -1)
		return true;
	for (let l = obs.length, i = 0; i < l; i++)
		if (findCycle(needle, obs[i]))
			return true;
	return false;
}