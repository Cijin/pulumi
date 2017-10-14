// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as log from "../log";
import { ID, Computed, ComputedValue, ComputedValues, Resource, URN } from "../resource";
import { errorString, debuggablePromise } from "./debuggable";
import { PropertyTransfer, transferProperties, resolveProperties } from "./rpc";
import { excessiveDebugOutput, getMonitor, options, rpcKeepAlive, serialize } from "./settings";

let langproto = require("../proto/languages_pb.js");

/**
 * resourceChain is used to serialize all resource requests.  If we don't do this, all resource operations will be
 * entirely asynchronous, meaning the dataflow graph that results will determine ordering of operations.  This
 * causes problems with some resource providers, so for now we will serialize all of them.  The issue
 * pulumi/pulumi#335 tracks coming up with a long-term solution here.
 */
let resourceChain: Promise<void> = Promise.resolve();

/**
 * registrations tracks all resources that have finished being registered.
 */
let registrations = new Set<Resource>();

/**
 * pendingRegistrations is used to track all unfinished resources so that we can resolve their URNs when done.
 */
let pendingRegistrations = new Map<Resource, (urn: URN | undefined) => void>();

/**
 * isRegistered returns true if the resource has begun being registered (no guarantee that it has finished yet).
 */
export function isRegistered(res: Resource): boolean {
    return registrations.has(res);
}

/**
 * initResource initializes a new resource object.
 */
export function initResource(res: Resource): void {
    if (registrations.has(res) || pendingRegistrations.has(res)) {
        throw new Error("Illegal attempt to initialize resource more than once");
    }

    // Simply initialize the URN property and get prepared to resolve it later on.
    (res as any).urn = debuggablePromise(new Promise<URN | undefined>((resolve) => {
        pendingRegistrations.set(res, resolve);
    }));
}

/**
 * registerResource registers a new resource object with a given type t and name.  It returns the auto-generated URN
 * and the ID that will resolve after the deployment has completed.  All properties will be initialized to property
 * objects that the registration operation will resolve at the right time (or remain unresolved for deployments).
 */
export function registerResource(res: Resource, t: string, name: string, external: boolean,
    props: ComputedValues | undefined, children: Resource[], dependsOn: Resource[] | undefined): void {
        log.debug(`Registering resource: t=${t}, name=${name}, external=${external}` +
        (excessiveDebugOutput ? `, props=${JSON.stringify(props)}` : ``));
    // Ensure we're not registering more than once.
    if (registrations.has(res)) {
        throw new Error("Illegal attempt to register resource more than once");
    }
    registrations.add(res);

    // Look up to ensure that this resource has been initialized.
    let resolveURN: ((url: URN | undefined) => void) | undefined = pendingRegistrations.get(res);
    if (!resolveURN) {
        throw new Error("Cannot register a resource that hasn't yet been initialized");
    }

    // Pre-allocate an error so we have a clean stack to print even if an asynchronous operation occurs.
    let createError: Error = new Error(`Resouce '${name}' [${t}] could not be created`);

    // If an external resource, make room for the ID property.
    let resolveID: ((v: ID | undefined) => void) | undefined;
    if (external) {
        (res as any).id = debuggablePromise(new Promise<ID | undefined>((resolve) => { resolveID = resolve; }));
    }

    // Ensure we depend on any children plus any explicit dependsOns.
    let allDependsOn: Resource[] | undefined;
    for (const depends of [ children, dependsOn ]) {
        if (depends && depends.length) {
            if (!allDependsOn) {
                allDependsOn = [];
            }
            allDependsOn = allDependsOn.concat(depends);
        }
    }

    // Now "transfer" all input properties; this simply awaits any promises and resolves when they all do.
    let transfer: Promise<PropertyTransfer> = debuggablePromise(
        transferProperties(res, `resource:${name}[${t}]`, props, allDependsOn));

    // Serialize the invocation if necessary.
    let resourceOp: Promise<void> = debuggablePromise(resourceChain.then(async () => {
        // Make sure to propagate these no matter what.
        let urn: URN | undefined = undefined;
        let id: ID | undefined = undefined;
        let propsStruct: any | undefined = undefined;
        let stable: boolean = false;
        let stables: Set<string> | undefined = undefined;

        // During a real deployment, the transfer operation may take some time to settle (we may need to wait on
        // other in-flight operations.  As a result, we can't launch the RPC request until they are done.  At the same
        // time, we want to give the illusion of non-blocking code, so we return immediately.
        let result: PropertyTransfer = await transfer;
        try {
            let obj: any = result.obj;
            log.debug(`Resource RPC prepared: t=${t}, name=${name}` +
                (excessiveDebugOutput ? `, obj=${JSON.stringify(obj)}` : ``));

            // Create a list of child URNs.
            let childURNs: URN[] = [];
            for (let child of children) {
                childURNs.push(await child.urn);
            }

            // Fetch the monitor and make an RPC request.
            let monitor: any = getMonitor();
            if (monitor) {
                let req = new langproto.NewResourceRequest();
                req.setType(t);
                req.setName(name);
                req.setChildrenList(childURNs);
                req.setExternal(external);
                req.setObject(obj);

                let resp: any = await debuggablePromise(new Promise((resolve, reject) => {
                    monitor.newResource(req, (err: Error, resp: any) => {
                        log.debug(`Resource RPC finished: t=${t}, name=${name}; err: ${err}, resp: ${resp}`);
                        if (err) {
                            log.error(`Failed to register new resource '${name}' [${t}]: ${err}`);
                            reject(err);
                        }
                        else {
                            resolve(resp);
                        }
                    });
                }));

                urn = resp.getUrn();
                id = resp.getId();
                propsStruct = resp.getObject();
                stable = resp.getStable();

                let stablesList: string[] | undefined = resp.getStablesList();
                if (stablesList) {
                    stables = new Set<string>();
                    for (let sta of stablesList) {
                        stables.add(sta);
                    }
                }
            }
            else {
                // If the monitor doesn't exist, still make sure to resolve all properties to undefined.
                log.debug(`Not sending RPC to monitor -- it doesn't exist: t=${t}, name=${name}`);
            }
        }
        finally {
            // If an ID is present, then it's safe to say it's final, because the resource planner wouldn't hand
            // it back to us otherwise (e.g., if the resource was being replaced, it would be missing).  If it isn't
            // available, ensure the ID gets resolved, just resolve it to undefined (indicating it isn't known).
            if (resolveID) {
                resolveID(id || undefined);
            }

            // Propagate any other properties that were given to us as outputs.
            resolveProperties(res, result, t, name, props, propsStruct, stable, stables);

            // Finally, the resolution will always have a valid URN, even during planning; set it.
            resolveURN!(urn);
        }
    }));

    // If any errors make it this far, ensure we log them.
    let finalOp: Promise<void> = debuggablePromise(resourceOp.catch((err: Error) => {
        // At this point, we've gone fully asynchronous, and the stack is missing.  To make it easier
        // to debug which resource this came from, we will emit the original stack trace too.
        log.error(errorString(createError));
        log.error(`Failed to create resource '${name}' [${t}]: ${errorString(err)}`);
    }));

    // Ensure the process won't exit until this registerResource call finishes and resolve it when appropriate.
    let done: () => void = rpcKeepAlive();
    finalOp.then(() => { done(); }, () => { done(); });

    // If serialization is requested, wait for the prior resource operation to finish before we proceed, serializing
    // them, and make this the current resource operation so that everybody piles up on it.
    if (serialize()) {
        resourceChain = finalOp;
    }
}

