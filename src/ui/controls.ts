/**
 * Contextual param capsule — auto-generated from the active mode's ParamDefs.
 * Opens by tapping the active tab again; floats 8px above the bar.
 */

import type { Engine } from '../engine/engine';
import type { ParamDef } from '../engine/types';
import { onLangChange, pick } from '../core/i18n';
import { writeState } from '../core/urlstate';

export interface ControlsHandle {
  toggleFor(modeId: string): void;
  close(): void;
  isOpen(): boolean;
  el: HTMLElement;
}

export function mountControls(root: HTMLElement, engine: Engine): ControlsHandle {
  const panel = document.createElement('div');
  panel.className = 'controls';
  panel.setAttribute('role', 'group');
  root.appendChild(panel);

  let openModeId: string | null = null;

  function currentValue(modeId: string, def: ParamDef): number | string {
    const stored = engine.getParamValues(modeId)[def.key];
    if (stored !== undefined) return def.type === 'range' ? Number(stored) : String(stored);
    return def.default;
  }

  function apply(key: string, value: number | string): void {
    engine.setModeParam(key, value);
    writeState({ params: { [key]: String(value) } });
  }

  function build(modeId: string): boolean {
    const mode = engine.modes.find((m) => m.id === modeId);
    const params = mode?.params;
    if (!mode || !params || params.length === 0) return false;
    panel.innerHTML = '';

    for (const def of params) {
      const row = document.createElement('div');
      row.className = 'control-row';

      const head = document.createElement('div');
      head.className = 'control-head';
      const label = document.createElement('span');
      label.textContent = pick(def.label);
      head.appendChild(label);
      row.appendChild(head);

      if (def.type === 'range') {
        const val = document.createElement('span');
        val.className = 'val';
        head.appendChild(val);

        const input = document.createElement('input');
        input.type = 'range';
        input.setAttribute('aria-label', pick(def.label));
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(currentValue(modeId, def));
        val.textContent = input.value;
        input.addEventListener('input', () => {
          val.textContent = input.value;
          apply(def.key, Number(input.value));
        });
        row.appendChild(input);
      } else if (def.type === 'text') {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-input';
        input.setAttribute('aria-label', pick(def.label));
        input.value = String(currentValue(modeId, def));
        if (def.maxLength) input.maxLength = def.maxLength;
        if (def.placeholder) input.placeholder = pick(def.placeholder);
        // 'input' fires during IME composition too — the mode re-targets on every change
        input.addEventListener('input', () => apply(def.key, input.value));
        row.appendChild(input);
      } else {
        const chips = document.createElement('div');
        chips.className = 'chips';
        const active = String(currentValue(modeId, def));
        for (const opt of def.options) {
          const chip = document.createElement('button');
          chip.className = 'chip' + (opt.value === active ? ' active' : '');
          chip.setAttribute('aria-pressed', String(opt.value === active));
          chip.textContent = pick(opt.label);
          chip.addEventListener('click', () => {
            for (const c of chips.children) {
              c.classList.remove('active');
              c.setAttribute('aria-pressed', 'false');
            }
            chip.classList.add('active');
            chip.setAttribute('aria-pressed', 'true');
            apply(def.key, opt.value);
          });
          chips.appendChild(chip);
        }
        row.appendChild(chips);
      }
      panel.appendChild(row);
    }
    return true;
  }

  function position(): void {
    const barWrap = document.querySelector('.bar-wrap');
    const bottom = barWrap
      ? window.innerHeight - barWrap.getBoundingClientRect().top + 8
      : 84;
    panel.style.bottom = `${bottom}px`;
  }

  function open(modeId: string): void {
    if (!build(modeId)) return;
    openModeId = modeId;
    position();
    panel.classList.add('open');
  }

  function close(): void {
    openModeId = null;
    panel.classList.remove('open');
    panel.style.transform = '';
  }

  // keep the panel above the software keyboard when an input would be covered
  const vv = window.visualViewport;
  if (vv) {
    const onVV = () => {
      if (!openModeId) return;
      // translate up only while an input inside the panel is focused, but always
      // allow the reset — otherwise the offset sticks when the input blurs and
      // the keyboard dismisses (the resize lands after focus already left)
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      panel.style.transform =
        covered > 0 && panel.contains(document.activeElement)
          ? `translateX(-50%) translateY(-${covered}px)`
          : '';
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  onLangChange(() => {
    if (openModeId) build(openModeId);
  });
  window.addEventListener('resize', () => {
    if (openModeId) position();
  });

  return {
    toggleFor(modeId: string): void {
      if (openModeId === modeId) close();
      else open(modeId);
    },
    close,
    isOpen: () => openModeId !== null,
    el: panel,
  };
}
