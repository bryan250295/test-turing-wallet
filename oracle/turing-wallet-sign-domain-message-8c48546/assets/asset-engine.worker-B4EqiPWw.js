(function() {
	function e(e, n) {
		let t, r;
		try {
			const i = a(e, g.__wbindgen_malloc, g.__wbindgen_realloc), c = p, l = a(n, g.__wbindgen_malloc, g.__wbindgen_realloc), f = p, d = g.execute_transaction_operation(i, c, l, f);
			var s = d[0], o = d[1];
			if (d[3]) throw s = 0, o = 0, u(d[2]);
			return t = s, r = o, _(s, o);
		} finally {
			g.__wbindgen_free(t, r, 1);
		}
	}
	function n() {
		return {
			__proto__: null,
			"./tbc_sdk_wasm_bg.js": {
				__proto__: null,
				__wbg___wbindgen_is_function_1ff95bcc5517c252: function(e) {
					return "function" == typeof e;
				},
				__wbg___wbindgen_is_object_a27215656b807791: function(e) {
					return "object" == typeof e && null !== e;
				},
				__wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(e) {
					return "string" == typeof e;
				},
				__wbg___wbindgen_is_undefined_c05833b95a3cf397: function(e) {
					return void 0 === e;
				},
				__wbg___wbindgen_throw_344f42d3211c4765: function(e, n) {
					throw new Error(_(e, n));
				},
				__wbg_call_a6e5c5dce5018821: function() {
					return i(function(e, n, t) {
						return e.call(n, t);
					}, arguments);
				},
				__wbg_crypto_38df2bab126b63dc: function(e) {
					return e.crypto;
				},
				__wbg_getRandomValues_3f44b700395062e5: function() {
					return i(function(e, n) {
						globalThis.crypto.getRandomValues(r(e, n));
					}, arguments);
				},
				__wbg_getRandomValues_c44a50d8cfdaebeb: function() {
					return i(function(e, n) {
						e.getRandomValues(n);
					}, arguments);
				},
				__wbg_length_1f0964f4a5e2c6d8: function(e) {
					return e.length;
				},
				__wbg_msCrypto_bd5a034af96bcba6: function(e) {
					return e.msCrypto;
				},
				__wbg_new_with_length_e6785c33c8e4cce8: function(e) {
					return new Uint8Array(e >>> 0);
				},
				__wbg_node_84ea875411254db1: function(e) {
					return e.node;
				},
				__wbg_process_44c7a14e11e9f69e: function(e) {
					return e.process;
				},
				__wbg_prototypesetcall_4770620bbe4688a0: function(e, n, t) {
					Uint8Array.prototype.set.call(r(e, n), t);
				},
				__wbg_randomFillSync_6c25eac9869eb53c: function() {
					return i(function(e, n) {
						e.randomFillSync(n);
					}, arguments);
				},
				__wbg_require_b4edbdcf3e2a1ef0: function() {
					return i(function() {
						return module.require;
					}, arguments);
				},
				__wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
					const e = "undefined" == typeof global ? null : global;
					return c(e) ? 0 : t(e);
				},
				__wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
					const e = "undefined" == typeof globalThis ? null : globalThis;
					return c(e) ? 0 : t(e);
				},
				__wbg_static_accessor_SELF_146583524fe1469b: function() {
					const e = "undefined" == typeof self ? null : self;
					return c(e) ? 0 : t(e);
				},
				__wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
					const e = "undefined" == typeof window ? null : window;
					return c(e) ? 0 : t(e);
				},
				__wbg_subarray_3ed232c8a6baee09: function(e, n, t) {
					return e.subarray(n >>> 0, t >>> 0);
				},
				__wbg_versions_276b2795b1c6a219: function(e) {
					return e.versions;
				},
				__wbindgen_cast_0000000000000001: function(e, n) {
					return r(e, n);
				},
				__wbindgen_cast_0000000000000002: function(e, n) {
					return _(e, n);
				},
				__wbindgen_init_externref_table: function() {
					const e = g.__wbindgen_externrefs, n = e.grow(4);
					e.set(0, void 0), e.set(n + 0, void 0), e.set(n + 1, null), e.set(n + 2, !0), e.set(n + 3, !1);
				}
			}
		};
	}
	function t(e) {
		const n = g.__externref_table_alloc();
		return g.__wbindgen_externrefs.set(n, e), n;
	}
	function r(e, n) {
		return e >>>= 0, o().subarray(e / 1, e / 1 + n);
	}
	function _(e, n) {
		return function(e, n) {
			return d += n, d >= f && (l = new TextDecoder("utf-8", {
				ignoreBOM: !0,
				fatal: !0
			}), l.decode(), d = n), l.decode(o().subarray(e, e + n));
		}(e >>> 0, n);
	}
	let s = null;
	function o() {
		return null !== s && 0 !== s.byteLength || (s = new Uint8Array(g.memory.buffer)), s;
	}
	function i(e, n) {
		try {
			return e.apply(this, n);
		} catch (r) {
			const e = t(r);
			g.__wbindgen_exn_store(e);
		}
	}
	function c(e) {
		return null == e;
	}
	function a(e, n, t) {
		if (void 0 === t) {
			const t = b.encode(e), r = n(t.length, 1) >>> 0;
			return o().subarray(r, r + t.length).set(t), p = t.length, r;
		}
		let r = e.length, _ = n(r, 1) >>> 0;
		const s = o();
		let i = 0;
		for (; i < r; i++) {
			const n = e.charCodeAt(i);
			if (n > 127) break;
			s[_ + i] = n;
		}
		if (i !== r) {
			0 !== i && (e = e.slice(i)), _ = t(_, r, r = i + 3 * e.length, 1) >>> 0;
			const n = o().subarray(_ + i, _ + r);
			i += b.encodeInto(e, n).written, _ = t(_, r, i, 1) >>> 0;
		}
		return p = i, _;
	}
	function u(e) {
		const n = g.__wbindgen_externrefs.get(e);
		return g.__externref_table_dealloc(e), n;
	}
	let l = new TextDecoder("utf-8", {
		ignoreBOM: !0,
		fatal: !0
	});
	l.decode();
	const f = 2146435072;
	let d = 0;
	const b = new TextEncoder();
	"encodeInto" in b || (b.encodeInto = function(e, n) {
		const t = b.encode(e);
		return n.set(t), {
			read: e.length,
			written: t.length
		};
	});
	let g, w, p = 0;
	const y = {
		BUILD_FT: "buildFt",
		BUILD_MERGE: "buildMerge",
		BUILD_MULTISIG: "buildMultiSig",
		BUILD_NFT: "buildNft",
		BUILD_POOL_NFT: "buildPoolNft",
		BUILD_STABLECOIN: "buildStableCoin",
		BUILD_TBC: "buildTbc",
		DECRYPT_MESSAGE: "decryptMessage",
		ENCRYPT_MESSAGE: "encryptMessage",
		INSPECT_TRANSACTION: "inspectTransaction",
		PLAN_FUNDING: "planFunding",
		PREPARE_ASSET_ANCESTRY: "prepareAssetAncestry",
		PREPARE_ASSET_OWNER: "prepareAssetOwner",
		PREPARE_POOL_NFT: "preparePoolNft",
		SIGN_ASSOCIATED: "signAssociated",
		SIGN_DOMAIN_MESSAGE: "signDomainMessage",
		SIGN_MESSAGE: "signMessage",
		SIGN_P2PKH: "signP2pkh"
	}, E = /* @__PURE__ */ new Set([
		"BUILD_MULTISIG",
		"BUILD_POOL_NFT",
		"PREPARE_POOL_NFT",
		"PLAN_FUNDING",
		"PREPARE_ASSET_ANCESTRY",
		"PREPARE_ASSET_OWNER",
		"INSPECT_TRANSACTION"
	]), S = [
		"ciphertext",
		"derivedKey",
		"encryptedMessage",
		"messageHex",
		"plaintext",
		"privateKeyWif",
		"saltHex",
		"signature",
		"sigs",
		"txraws",
		"valid"
	];
	function A() {
		return w ??= async function(e) {
			if (void 0 !== g) return g;
			void 0 !== e && Object.getPrototypeOf(e) === Object.prototype && ({module_or_path: e} = e), void 0 === e && (e = new URL("/assets/tbc_sdk_wasm_bg-BexZyptE.wasm", "" + self.location.href));
			const t = n();
			("string" == typeof e || "function" == typeof Request && e instanceof Request || "function" == typeof URL && e instanceof URL) && (e = fetch(e));
			const { instance: r, module: _ } = await async function(e, n) {
				if ("function" == typeof Response && e instanceof Response) {
					if ("function" == typeof WebAssembly.instantiateStreaming) try {
						return await WebAssembly.instantiateStreaming(e, n);
					} catch (t) {
						if (!e.ok || !function(e) {
							switch (e) {
								case "basic":
								case "cors":
								case "default": return !0;
							}
							return !1;
						}(e.type) || "application/wasm" === e.headers.get("Content-Type")) throw t;
					}
					const r = await e.arrayBuffer();
					return await WebAssembly.instantiate(r, n);
				}
				{
					const t = await WebAssembly.instantiate(e, n);
					return t instanceof WebAssembly.Instance ? {
						instance: t,
						module: e
					} : t;
				}
			}(await e, t);
			return function(e) {
				return g = e.exports, s = null, g.__wbindgen_start(), g;
			}(r);
		}().then(() => JSON.parse(function() {
			let e, n;
			try {
				const t = g.protocol_info();
				return e = t[0], n = t[1], _(t[0], t[1]);
			} finally {
				g.__wbindgen_free(e, n, 1);
			}
		}()).version), w;
	}
	self.onmessage = async (n) => {
		const t = n.data;
		if ("INITIALIZE" !== t.type) try {
			let n;
			await A();
			const r = y[t.type];
			if ("EXECUTE" === t.type) {
				const { operation: r, payload: _ } = JSON.parse(t.requestJson);
				n = e(r, JSON.stringify(_));
			} else if ("PREPARE_ASSET_OWNER" === t.type) {
				const { address: r, codeScript: _ } = JSON.parse(t.requestJson), s = JSON.parse(e("inspectTbcAddress", JSON.stringify({ address: r })));
				if ("p2pkh" !== s.kind || !s.hash160) throw new Error("Asset owner must be a P2PKH address");
				const o = JSON.parse(e("deriveTbcContractScript", JSON.stringify({
					codeScript: _,
					kind: "ftTransfer",
					receiver: r
				})));
				n = JSON.stringify({
					combineScript: `${s.hash160}00`,
					ownerCodeScript: o.script
				});
			} else if ("INSPECT_TRANSACTION" === t.type) {
				const r = JSON.parse(e("inspectTbcTransaction", t.requestJson));
				n = JSON.stringify({
					...r,
					inputs: r.inputs.map((e) => ({
						...e,
						prevTxid: e.prevTxId
					})),
					locktime: r.lockTime,
					outputs: r.outputs.map((e, n) => ({
						...e,
						outputIndex: n
					})),
					size: r.raw.length / 2
				});
			} else if (r) n = e(r, t.requestJson);
			else switch (t.type) {
				case "DERIVE_PASSWORD_KEY":
					n = function(e) {
						let n, t;
						try {
							const o = a(e, g.__wbindgen_malloc, g.__wbindgen_realloc), i = p, c = g.derive_password_key(o, i);
							var r = c[0], s = c[1];
							if (c[3]) throw r = 0, s = 0, u(c[2]);
							return n = r, t = s, _(r, s);
						} finally {
							g.__wbindgen_free(n, t, 1);
						}
					}(t.requestJson);
					break;
				case "VERIFY_PASSWORD":
					n = function(e) {
						let n, t;
						try {
							const o = a(e, g.__wbindgen_malloc, g.__wbindgen_realloc), i = p, c = g.verify_password(o, i);
							var r = c[0], s = c[1];
							if (c[3]) throw r = 0, s = 0, u(c[2]);
							return n = r, t = s, _(r, s);
						} finally {
							g.__wbindgen_free(n, t, 1);
						}
					}(t.requestJson);
					break;
				case "GENERATE_SALT":
					n = function() {
						let e, n;
						try {
							const s = g.generate_salt();
							var t = s[0], r = s[1];
							if (s[3]) throw t = 0, r = 0, u(s[2]);
							return e = t, n = r, _(t, r);
						} finally {
							g.__wbindgen_free(e, n, 1);
						}
					}();
					break;
				case "GENERATE_WALLET":
					n = function(e) {
						let n, t;
						try {
							const o = a(e, g.__wbindgen_malloc, g.__wbindgen_realloc), i = p, c = g.generate_wallet(o, i);
							var r = c[0], s = c[1];
							if (c[3]) throw r = 0, s = 0, u(c[2]);
							return n = r, t = s, _(r, s);
						} finally {
							g.__wbindgen_free(n, t, 1);
						}
					}(t.requestJson);
					break;
				case "ENCRYPT_VAULT":
					n = function(e) {
						let n, t;
						try {
							const o = a(e, g.__wbindgen_malloc, g.__wbindgen_realloc), i = p, c = g.encrypt_vault(o, i);
							var r = c[0], s = c[1];
							if (c[3]) throw r = 0, s = 0, u(c[2]);
							return n = r, t = s, _(r, s);
						} finally {
							g.__wbindgen_free(n, t, 1);
						}
					}(t.requestJson);
					break;
				case "DECRYPT_VAULT":
					n = function(e) {
						let n, t;
						try {
							const o = a(e, g.__wbindgen_malloc, g.__wbindgen_realloc), i = p, c = g.decrypt_vault(o, i);
							var r = c[0], s = c[1];
							if (c[3]) throw r = 0, s = 0, u(c[2]);
							return n = r, t = s, _(r, s);
						} finally {
							g.__wbindgen_free(n, t, 1);
						}
					}(t.requestJson);
					break;
				default: throw new Error(`Unsupported Rust worker request: ${t.type}`);
			}
			const s = JSON.parse(n), o = "EXECUTE" === t.type ? s : ((e, n) => E.has(n) || !Array.isArray(e) && S.some((n) => n in e) ? e : Array.isArray(e) ? { transactions: e } : "transactions" in e ? e : { transactions: [e] })(s, t.type);
			self.postMessage({
				requestId: t.requestId,
				result: o,
				type: "BUILD_RESULT"
			});
		} catch (r) {
			self.postMessage({
				error: r instanceof Error ? r.message : String(r),
				requestId: t.requestId,
				type: "BUILD_ERROR"
			});
		}
		else try {
			self.postMessage({
				protocolVersion: await A(),
				type: "READY"
			});
		} catch (r) {
			self.postMessage({
				error: r instanceof Error ? r.message : String(r),
				type: "INITIALIZATION_ERROR"
			});
		}
	};
})();
