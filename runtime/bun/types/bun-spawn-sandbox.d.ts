declare module "bun" {
  namespace Spawn {
    interface SandboxOptions {
      /**
       * Path to a native shared library implementing the Bun spawn sandbox ABI.
       */
      library: string;
      /**
       * UTF-8 configuration passed to `bun_spawn_sandbox_prepare`.
       */
      config?: string;
    }

    interface BaseOptions<In extends Writable, Out extends Readable, Err extends Readable> {
      /**
       * Apply a native sandbox provider before the child calls `exec`.
       *
       * Provided by the Bugent Bun fork. POSIX only.
       */
      sandbox?: SandboxOptions;
    }
  }
}
