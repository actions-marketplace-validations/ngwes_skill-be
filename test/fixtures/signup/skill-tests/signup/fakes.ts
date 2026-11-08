export type NewUser = { email: string; password: string };

export type Deps = {
  isEmailTaken: (email: string) => Promise<boolean>;
  createUser: (user: NewUser) => Promise<{ id: number; email: string }>;
};

/** What the contract says `result` is: the editor checks the tests against it. */
export type Signup = (deps: Deps) => (input: NewUser) => Promise<{ status: number; body: unknown }>;

/**
 * Dependencies for one test. Nobody has the email unless `taken` is true, and `created` lists the
 * users the code asked to save.
 */
export function fakeDeps({ taken }: { taken: boolean }): Deps & { created: NewUser[] } {
  const created: NewUser[] = [];
  return {
    created,
    isEmailTaken: async () => taken,
    createUser: async (user) => {
      created.push(user);
      return { id: created.length, email: user.email };
    },
  };
}
