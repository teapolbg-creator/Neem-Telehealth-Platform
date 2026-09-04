import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TEMPLATES,
  validateTemplateBody,
} from '../../src/modules/notification/templates.ts';
import { render } from '../../src/modules/notification/notification.service.ts';

/**
 * The Phase 8 exit criterion (spec §58, §60).
 *
 * > every notification in spec §58 fires on its trigger; no notification
 * > payload contains clinical content.
 *
 * The second half is asserted here, against the catalogue itself rather than
 * against messages after they are sent. A template that could carry clinical
 * content is a defect whether or not it has been used yet.
 */

describe('the notification catalogue', () => {
  it('carries no clinical content in any template', () => {
    const offenders = NOTIFICATION_TEMPLATES.flatMap((template) =>
      validateTemplateBody(template.body, template.variables).map((problem) => ({
        template: template.code,
        ...problem,
      })),
    );

    expect(offenders).toEqual([]);
  });

  it('carries no clinical content in any subject either', () => {
    const offenders = NOTIFICATION_TEMPLATES.filter((template) => template.subject).flatMap(
      (template) =>
        validateTemplateBody(template.subject!, template.variables).map((problem) => ({
          template: template.code,
          ...problem,
        })),
    );

    expect(offenders).toEqual([]);
  });

  it('declares every variable each body uses', () => {
    for (const template of NOTIFICATION_TEMPLATES) {
      const used = [...template.body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);

      for (const variable of used) {
        expect(template.variables, `${template.code} uses {{${variable}}}`).toContain(variable);
      }
    }
  });

  it('has a unique code for every template', () => {
    const codes = NOTIFICATION_TEMPLATES.map((template) => template.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('sends every template on at least one channel', () => {
    for (const template of NOTIFICATION_TEMPLATES) {
      expect(template.channels.length, template.code).toBeGreaterThan(0);
    }
  });

  /**
   * An SMS is readable by anyone holding the handset and cannot be withdrawn.
   * Whatever else a template says, one that goes to a patient by SMS must be
   * safe to read over someone's shoulder.
   */
  it('gives a patient nothing on SMS beyond a reference', () => {
    const toPatients = NOTIFICATION_TEMPLATES.filter((template) =>
      template.code.startsWith('patient.'),
    );

    expect(toPatients.length).toBeGreaterThan(0);

    for (const template of toPatients) {
      for (const variable of template.variables) {
        // A reference is an opaque token. A name, an age or a diagnosis is not.
        expect(['consultationReference'], template.code).toContain(variable);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('the forbidden-content check', () => {
  it('catches clinical wording written as literal text', () => {
    // The case the variable allow-list cannot catch: no placeholder at all.
    const problems = validateTemplateBody('Your malaria test was positive.', []);

    expect(problems.map((problem) => problem.code)).toContain('clinical-content');
  });

  it('catches a variable the template was never given', () => {
    const problems = validateTemplateBody('Your diagnosis is {{diagnosis}}.', ['pharmacyName']);

    expect(problems.map((problem) => problem.code)).toContain('unknown-variable');
  });

  /**
   * Short words are matched whole.
   *
   * A check that fired on every substring — "mg" inside "amgen", "dose"
   * inside "doses of goodwill" — would be turned off within a week, which is
   * worse than not having it.
   */
  it('does not fire on innocent words that merely contain a forbidden one', () => {
    expect(validateTemplateBody('Amgen Pharmacy is waiting.', [])).toEqual([]);
    expect(validateTemplateBody('A doctor has accepted.', [])).toEqual([]);
  });

  it('fires on a real dosage', () => {
    expect(validateTemplateBody('Take 500 mg twice daily.', []).length).toBeGreaterThan(0);
    expect(validateTemplateBody('One dose remaining.', []).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('rendering', () => {
  it('substitutes what it was given', () => {
    expect(render('Waiting at {{pharmacyName}}.', { pharmacyName: 'Akosua' })).toBe(
      'Waiting at Akosua.',
    );
  });

  /**
   * The failure that matters.
   *
   * A message reaching a patient reading "Your reference is
   * {{consultationReference}}" is worse than one never sent: it looks like the
   * system working, and the reference it was supposed to carry is lost.
   */
  it('refuses a placeholder it cannot fill rather than sending it raw', () => {
    expect(() => render('Your reference is {{consultationReference}}.', {})).toThrow(
      /consultationReference/,
    );
  });

  it('leaves text with no placeholders alone', () => {
    expect(render('Your account is suspended.', {})).toBe('Your account is suspended.');
  });

  it('renders every catalogue template when given its declared variables', () => {
    for (const template of NOTIFICATION_TEMPLATES) {
      const variables = Object.fromEntries(template.variables.map((name) => [name, `<${name}>`]));

      // Proves the two halves agree: nothing in a body needs a variable the
      // template does not declare.
      expect(() => render(template.body, variables), template.code).not.toThrow();
    }
  });
});
