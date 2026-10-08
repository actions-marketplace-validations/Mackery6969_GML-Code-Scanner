import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventCode, findingsFor, scriptCode } from "./helpers.ts";

const count = (files: Record<string, string>, rule: string) => findingsFor(files, rule).length;

describe("correctness rules", () => {
  it("undefined-function", () => {
    assert.equal(count(eventCode("scr_missing(1);"), "gml/undefined-function"), 1);
    assert.equal(count(eventCode("draw_self(); scr_ok();", "Step_0", scriptCode("function scr_ok() {}", "scr_ok")), "gml/undefined-function"), 0);
    // method variables are not undefined
    assert.equal(count(eventCode("move = function() {}; move();"), "gml/undefined-function"), 0);
    const [legacy] = findingsFor(eventCode("instance_create(x, y, obj_test);"), "gml/undefined-function");
    assert.match(legacy.message, /instance_create_layer/);
  });

  it("wrong-argument-count", () => {
    assert.equal(count(eventCode("draw_text(x, y);"), "gml/wrong-argument-count"), 1);
    assert.equal(count(eventCode("draw_text(x, y, \"a\", 1);"), "gml/wrong-argument-count"), 1);
    assert.equal(count(eventCode("array_push(a, 1, 2, 3);"), "gml/wrong-argument-count"), 0);
    const files = scriptCode("function hurt(target, amount = 1) { target.hp -= amount; }\nfunction vararg() { return argument_count; }", "scr_fns");
    assert.equal(count({ ...files, ...eventCode("hurt(self, 1, true); vararg(1, 2, 3); hurt(self);") }, "gml/wrong-argument-count"), 1);
    assert.equal(count({ ...files, ...eventCode("hurt();") }, "gml/wrong-argument-count"), 1);
  });

  it("extension argument counts come from the args list", () => {
    const yy = `{"resourceType":"GMExtension","name":"ext_x","files":[{"filename":"ext_x.dll","kind":1,"functions":[{"name":"ext_do","argCount":0,"args":[1,2],"kind":1,},],"constants":[],},],}`;
    const files = { ...eventCode("ext_do(1, 2); ext_do(1);", "Create_0"), "extensions/ext_x/ext_x.yy": yy };
    const f = findingsFor(files, "gml/wrong-argument-count", { extraEntries: [`    {"id":{"name":"ext_x","path":"extensions/ext_x/ext_x.yy",},"order":0,},`] });
    assert.equal(f.length, 1);
    assert.match(f[0].message, /declared with 2 arguments/);
  });

  it("undefined-variable", () => {
    assert.equal(count(eventCode("x += move_sped;", "Step_0", { "objects/obj_test/Create_0.gml": "move_speed = 4;" }), "gml/undefined-variable"), 1);
    assert.equal(count(eventCode("x += move_speed;", "Step_0", { "objects/obj_test/Create_0.gml": "move_speed = 4;" }), "gml/undefined-variable"), 0);
    assert.equal(count(eventCode("show_debug_message(global.scroe);", "Step_0", { "objects/obj_test/Create_0.gml": "global.score_total = 0;" }), "gml/undefined-variable"), 1);
    const [asset] = findingsFor(eventCode("sprite_index = spr_deleted;"), "gml/undefined-variable");
    assert.match(asset.message, /sprite name/);
  });

  it("undefined-variable honours globalPrefixes", () => {
    assert.equal(findingsFor(eventCode("x = g_speed;"), "gml/undefined-variable", { config: { globalPrefixes: ["g_"] } }).length, 0);
  });

  it("uncaptured-local", () => {
    assert.equal(count(eventCode("var total = 0; array_foreach(a, function(v) { total += v; });", "Create_0"), "gml/uncaptured-local"), 1);
    assert.equal(count(eventCode("var total = 0; with (obj_test) { total += 1; }", "Create_0"), "gml/uncaptured-local"), 0);
  });

  it("string-number-addition", () => {
    assert.equal(count(eventCode('draw_text(0, 0, "Score: " + 10);', "Draw_0"), "gml/string-number-addition"), 1);
    assert.equal(count(eventCode('draw_text(0, 0, "X: " + x);', "Draw_0"), "gml/string-number-addition"), 1);
    assert.equal(count(eventCode('draw_text(0, 0, "Len: " + string_length(s));', "Draw_0"), "gml/string-number-addition"), 1);
    assert.equal(count(eventCode('draw_text(0, 0, "Score: " + string(10) + $"{x}");', "Draw_0"), "gml/string-number-addition"), 0);
    assert.equal(count(eventCode('var s = "a"; s += 5;', "Create_0"), "gml/string-number-addition"), 1);
  });

  it("unreachable-code", () => {
    assert.equal(count(eventCode("exit; x = 1;"), "gml/unreachable-code"), 1);
    assert.equal(count(eventCode("switch (a) { case 1: exit; break; }"), "gml/unreachable-code"), 0);
    assert.equal(count(eventCode("if (a) exit; x = 1;"), "gml/unreachable-code"), 0);
  });

  it("empty-statement-body", () => {
    assert.equal(count(eventCode("if (keyboard_check(vk_space)); { y -= 4; }"), "gml/empty-statement-body"), 1);
    assert.equal(count(eventCode("if (keyboard_check(vk_space)) { y -= 4; }"), "gml/empty-statement-body"), 0);
  });

  it("infinite-loop", () => {
    assert.equal(count(eventCode("while (true) { x += 1; }"), "gml/infinite-loop"), 1);
    assert.equal(count(eventCode("while (true) { if (x > 10) break; x += 1; }"), "gml/infinite-loop"), 0);
    // `break` inside switch does not leave the loop
    assert.equal(count(eventCode("while (true) { switch (a) { case 1: break; } }"), "gml/infinite-loop"), 1);
    assert.equal(count(eventCode("do { x++; } until (false);"), "gml/infinite-loop"), 1);
  });

  it("self-assignment and self-comparison", () => {
    assert.equal(count(eventCode("with (obj_test) { x = x; }"), "gml/self-assignment"), 1);
    assert.equal(count(eventCode("with (obj_test) { x = other.x; }"), "gml/self-assignment"), 0);
    assert.equal(count(eventCode("if (team == team) {}"), "gml/self-comparison"), 1);
  });

  it("duplicate-case, division-by-zero, readonly-assignment", () => {
    assert.equal(count(eventCode("switch (s) { case 1: break; case 1: break; }"), "gml/duplicate-case"), 1);
    assert.equal(count(eventCode("a = b / 0; c = d mod 0;"), "gml/division-by-zero"), 2);
    assert.equal(count(eventCode("fps = 60; instance_count = 0;"), "gml/readonly-assignment"), 2);
    assert.equal(count(eventCode("var fps = 60;"), "gml/readonly-assignment"), 0);
  });

  it("deprecated (one finding per name per file)", () => {
    const f = findingsFor(eventCode("a = array_length_1d(b); c = array_length_1d(d); alarm[0] = room_speed;"), "gml/deprecated");
    assert.equal(f.length, 2);
    assert.ok(f.some((x) => /2 uses/.test(x.message)));
  });

  it("global-scope-self", () => {
    assert.equal(count(scriptCode("self.hp = 100;"), "gml/global-scope-self"), 1);
    assert.equal(count(scriptCode("function f() { self.hp = 100; }"), "gml/global-scope-self"), 0);
  });
});

describe("GameMaker rules", () => {
  it("resource-leak", () => {
    assert.equal(count(eventCode("var l = ds_list_create(); instance_place_list(x, y, obj_test, l, false);"), "gml/resource-leak"), 1);
    assert.equal(count(eventCode("var l = ds_list_create(); ds_list_add(l, 1); ds_list_destroy(l);"), "gml/resource-leak"), 0);
    assert.equal(count(eventCode("var l = ds_list_create(); return l;"), "gml/resource-leak"), 0);
    assert.equal(count(eventCode("inv = ds_list_create();", "Create_0"), "gml/resource-leak"), 1);
    assert.equal(count(eventCode("inv = ds_list_create();", "Create_0", { "objects/obj_test/CleanUp_0.gml": "ds_list_destroy(inv);" }), "gml/resource-leak"), 0);
  });

  it("surface-exists-check", () => {
    const create = { "objects/obj_test/Create_0.gml": "surf = surface_create(64, 64);" };
    assert.equal(count(eventCode("surface_set_target(surf); surface_reset_target();", "Draw_0", create), "gml/surface-exists-check"), 1);
    assert.equal(count(eventCode("if (!surface_exists(surf)) surf = surface_create(64, 64); surface_set_target(surf); surface_reset_target();", "Draw_0", create), "gml/surface-exists-check"), 0);
  });

  it("unbalanced-state", () => {
    assert.equal(count(eventCode("ini_open(\"a.ini\"); v = ini_read_real(\"a\", \"b\", 0);", "Create_0"), "gml/unbalanced-state"), 1);
    assert.equal(count(eventCode("ini_open(\"a.ini\"); if (a) { ini_close(); exit; } ini_close();", "Create_0"), "gml/unbalanced-state"), 0);
  });

  it("draw-outside-draw-event", () => {
    assert.equal(count(eventCode("draw_text(x, y, \"hi\");", "Step_0"), "gml/draw-outside-draw-event"), 1);
    assert.equal(count(eventCode("draw_text(x, y, \"hi\");", "Draw_64"), "gml/draw-outside-draw-event"), 0);
    assert.equal(count(eventCode("draw_set_color(c_red);", "Step_0"), "gml/draw-outside-draw-event"), 0);
  });

  it("unconditional-per-frame-action", () => {
    assert.equal(count(eventCode("alarm[0] = 60;"), "gml/unconditional-per-frame-action"), 1);
    assert.equal(count(eventCode("if (alarm[0] < 0) alarm[0] = 60;"), "gml/unconditional-per-frame-action"), 0);
    assert.equal(count(eventCode("audio_play_sound(snd, 1, false);"), "gml/unconditional-per-frame-action"), 1);
    assert.equal(count(eventCode("if (!active) exit; audio_play_sound(snd, 1, false);"), "gml/unconditional-per-frame-action"), 0);
    assert.equal(count(eventCode("alarm[0] = 60;", "Create_0"), "gml/unconditional-per-frame-action"), 0);
  });
});

describe("performance rules", () => {
  it("per-frame-expensive-call", () => {
    assert.equal(count(eventCode("shader_set(sh); shader_set_uniform_f(shader_get_uniform(sh, \"t\"), 1); shader_reset();", "Draw_0"), "gml/per-frame-expensive-call"), 1);
    assert.equal(count(eventCode("if (u == -1) u = shader_get_uniform(sh, \"t\");", "Draw_0"), "gml/per-frame-expensive-call"), 0);
    assert.equal(count(eventCode("ini_open(\"s.ini\"); ini_close();", "Step_0"), "gml/per-frame-expensive-call"), 1);
    assert.equal(count(eventCode("if (keyboard_check_pressed(vk_f5)) { ini_open(\"s.ini\"); ini_close(); }", "Step_0"), "gml/per-frame-expensive-call"), 0);
  });

  it("string-char-at-loop", () => {
    assert.equal(count(eventCode("for (var i = 1; i <= string_length(s); i++) { c = string_char_at(s, i); }", "Create_0"), "gml/string-char-at-loop"), 1);
    assert.equal(count(eventCode("c = string_char_at(s, 1);", "Create_0"), "gml/string-char-at-loop"), 0);
  });

  it("instance-number-as-exists", () => {
    assert.equal(count(eventCode("if (instance_number(obj_test) > 0) {} if (instance_number(obj_test) == 0) {}"), "gml/instance-number-as-exists"), 2);
    assert.equal(count(eventCode("if (instance_number(obj_test) > 3) {}"), "gml/instance-number-as-exists"), 0);
  });

  it("loop-invariant-length", () => {
    assert.equal(count(eventCode("for (var i = 0; i < array_length(a); i++) { total += a[i]; }", "Create_0"), "gml/loop-invariant-length"), 1);
    assert.equal(count(eventCode("for (var i = 0; i < array_length(a); i++) { array_delete(a, i, 1); }", "Create_0"), "gml/loop-invariant-length"), 0);
  });

  it("quality suggestions", () => {
    assert.equal(count(eventCode("script_execute(scr_fn, 1);", "Create_0", scriptCode("function scr_fn(a) {}", "scr_fn")), "gml/redundant-script-execute"), 1);
    assert.equal(count(eventCode("hp = variable_instance_get(other, \"hp\");", "Create_0"), "gml/literal-variable-access"), 1);
    assert.equal(count(eventCode("d = power(x, 2) + sqrt(sqr(a) + sqr(b));", "Create_0"), "gml/math-shortcut"), 2);
  });
});

describe("maintainability rules", () => {
  it("jsdoc-param-mismatch", () => {
    assert.equal(count(scriptCode("/// @param {Id.Instance} target\n/// @param {Real} amount\nfunction scr_damage(target, dmg) {}"), "gml/jsdoc-param-mismatch"), 1);
    assert.equal(count(scriptCode("/// @param target\n/// @param [amount]\nfunction scr_damage(target, amount) {}"), "gml/jsdoc-param-mismatch"), 0);
  });

  it("implicit-global and globalvar", () => {
    assert.equal(count(scriptCode("max_speed = 4;"), "gml/implicit-global"), 1);
    assert.equal(count(scriptCode("globalvar gv; gv = 1;"), "gml/implicit-global"), 0);
    assert.equal(count(scriptCode("globalvar gv;"), "gml/globalvar"), 1);
  });

  it("switch-fallthrough", () => {
    assert.equal(count(eventCode("switch (a) { case 0: x += 1; case 1: y += 1; break; }"), "gml/switch-fallthrough"), 1);
    assert.equal(count(eventCode("switch (a) { case 0: x += 1; // fallthrough\n case 1: y += 1; break; }"), "gml/switch-fallthrough"), 0);
  });

  it("unused-local and duplicate-struct-key", () => {
    assert.equal(count(eventCode("var unused = 1; var used = 2; x = used;", "Create_0"), "gml/unused-local"), 1);
    assert.equal(count(eventCode("s = { hp: 1, hp: 2 };", "Create_0"), "gml/duplicate-struct-key"), 1);
  });

  it("missing-event-inherited", () => {
    const files = {
      "objects/obj_parent/Create_0.gml": "hp = 10;",
      "objects/obj_child/Create_0.gml": "speed = 2;",
      "objects/obj_child/obj_child.yy": `{"resourceType":"GMObject","name":"obj_child","eventList":[{"eventNum":0,"eventType":0,"collisionObjectId":null,},],"parentObjectId":{"name":"obj_parent","path":"objects/obj_parent/obj_parent.yy",},"properties":[],}`,
    };
    assert.equal(count(files, "gml/missing-event-inherited"), 1);
    assert.equal(count({ ...files, "objects/obj_child/Create_0.gml": "event_inherited(); speed = 2;" }, "gml/missing-event-inherited"), 0);
  });

  it("declaration-outside-script", () => {
    const files = {
      ...eventCode("enum e_state { idle }\n#macro SPEED 4\nglobalvar g_score;\nglobal.lives = 3;", "Create_0"),
      "rooms/rm_main/RoomCreationCode.gml": "enum e_room { a }\nglobal.level = 1;",
      "rooms/rm_main/InstanceCreationCode_inst_1.gml": "#macro ROOM_FPS 60",
      ...scriptCode("enum e_ok { a }\n#macro OK 1\nglobalvar g_ok;", "scr_decl"),
    };
    const f = findingsFor(files, "gml/declaration-outside-script");
    assert.equal(f.length, 5);
    assert.ok(f.some((x) => /^Enum `e_state` is declared in the Create event of `obj_test`/.test(x.message)));
    assert.ok(f.some((x) => /^Global variable `g_score`/.test(x.message)));
    assert.ok(f.some((x) => /^Enum `e_room` is declared in the creation code of room `rm_main`/.test(x.message)));
    assert.ok(f.some((x) => /^Macro `ROOM_FPS` is declared in the creation code of instance `inst_1` in room `rm_main`/.test(x.message)));
    assert.ok(f.every((x) => !x.location.file.startsWith("scripts/")));
  });
});
