{
    description = "dim-controller: drive a running dimOS robot with its live 3D view, cameras and recording, as a dimOS Desktop app";

    inputs = {
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
        rust-overlay.url = "github:oxalica/rust-overlay";
        rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
        # deps build once into their own derivation (keyed on Cargo.toml / Cargo.lock), so a commit that only edits our code rebuilds just our crate
        crane.url = "github:ipetkov/crane";
    };
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };

    outputs = { self, nixpkgs, rust-overlay, crane }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; overlays = [ (import rust-overlay) ]; }));
        in {
            packages = forAllSystems (pkgs:
                let
                    rust = pkgs.rust-bin.stable.latest.default;

                    # the page: React + Vite (type-checked first), from package-lock.json
                    frontend = pkgs.buildNpmPackage {
                        pname = "dim-controller-frontend";
                        version = "0.1.0";
                        src = ./frontend;
                        npmDepsHash = "sha256-arJEV4KNF43XzKnCFZKSdr3P8a/Fhw29LnS+w2qdCSE=";
                        # npm writes the git dependency (dimos-react) into its cache while installing
                        makeCacheWritable = true;
                        installPhase = ''
                            cp -r dist $out
                        '';
                    };

                    # the backend: serves the page and records topics to mcap (independent of the page, so a page
                    # change doesn't rebuild it)
                    # crane: buildDepsOnly compiles every dependency against a dummy of our crate (so its hash only moves with Cargo.toml / Cargo.lock), buildPackage starts from that target dir
                    rustBuild = { craneLib, pname, cargoExtraArgs, extra ? { }, install ? { } }:
                        let
                            common = {
                                inherit pname cargoExtraArgs;
                                version = "0.1.0";
                                src = ./server;
                                # the tests open zenoh sessions on loopback; `cargo test` runs them in development
                                doCheck = false;
                                strictDeps = true;
                            } // extra;
                            cargoArtifacts = craneLib.buildDepsOnly (common // {
                                # only the build's artifacts are reused; a `cargo check` pass would be a second compile nobody reads
                                cargoCheckCommand = "true";
                            });
                        in
                        craneLib.buildPackage (common // {
                            inherit cargoArtifacts;
                            # nothing builds on this target dir, so don't archive it into $out
                            doInstallCargoArtifacts = false;
                        } // install);

                    server = rustBuild {
                        craneLib = (crane.mkLib pkgs).overrideToolchain (_: rust);
                        pname = "dim-controller-server";
                        cargoExtraArgs = "--locked";
                    };

                    # <arch> Linux from any machine: a static musl binary linked by zig, so no Linux builder or cross gcc
                    crossServer = arch:
                        let
                            target = "${arch}-unknown-linux-musl";
                            envTarget = builtins.replaceStrings [ "-" ] [ "_" ] target;
                            zigShim = wrapper: pkgs.writeShellScript "zigbuild-shim" "exec \"$CARGO_ZIGBUILD_CACHE_DIR\"/cargo-zigbuild/*/wrappers/*/${wrapper} \"$@\"";
                            rustCross = rust.override { targets = [ target ]; };
                        in
                        rustBuild {
                            craneLib = (crane.mkLib pkgs).overrideToolchain (_: rustCross);
                            pname = "dim-controller-server-${arch}-linux";
                            cargoExtraArgs = "--locked -p dimos-app-server --target ${target}";
                            extra = {
                                nativeBuildInputs = [ pkgs.cargo-zigbuild pkgs.zig ];
                                cargoBuildCommand = "cargo zigbuild --profile release";
                                # cargo fingerprints the linker, CC and AR paths, so they are nix-store shims (the same in every build, whichever nixbld user runs it) that hand off to the wrappers zigbuild writes in this build's own $TMPDIR; zigbuild leaves a CC / linker it finds set alone
                                # (not one shared dir: zigbuild writes its wrappers 0700, so a second nixbld user, as in CI's parallel builds, can't run them)
                                preBuild = ''
                                    export HOME=$TMPDIR ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig CARGO_ZIGBUILD_CACHE_DIR=$TMPDIR/zigbuild
                                    export CC_${envTarget}=${zigShim "zigcc-${target}-*.sh"} CXX_${envTarget}=${zigShim "zigcxx-${target}-*.sh"} AR_${envTarget}=${zigShim "ar"} RANLIB_${envTarget}=${zigShim "zigranlib.sh"}
                                    export CARGO_TARGET_${pkgs.lib.toUpper envTarget}_LINKER=$CC_${envTarget}
                                '';
                            };
                            install = {
                                installPhaseCommand = "install -Dm755 target/${target}/release/dimos-app-server $out/bin/dimos-app-server";
                            };
                        };
                    # the same wrapper as dimosApp, but its shell is the target's (a cache.nixos.org download); the frontend is plain JS
                    linuxApp = arch:
                        let linux = nixpkgs.legacyPackages."${arch}-linux"; in
                        pkgs.runCommand "dim-controller-${arch}-linux" { } ''
                            mkdir -p $out/bin
                            printf '#!%s\nexport CONTROLLER_FRONTEND="''${CONTROLLER_FRONTEND:-%s}"\nexec %s "$@"\n' \
                                ${linux.runtimeShell} ${frontend} ${crossServer arch}/bin/dimos-app-server > $out/bin/dimos-app-server
                            chmod +x $out/bin/dimos-app-server
                            cp ${./icon.svg} $out/icon.svg
                        '';
                in {
                    inherit frontend server;
                    # what Desktop builds: bin/dimos-app-server, which serves everything under /apps/<name>/
                    dimosApp = pkgs.runCommand "dim-controller" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
                        mkdir -p $out/bin
                        makeWrapper ${server}/bin/dimos-app-server $out/bin/dimos-app-server --set-default CONTROLLER_FRONTEND ${frontend}
                        cp ${./icon.svg} $out/icon.svg
                    '';
                    default = self.packages.${pkgs.system}.dimosApp;
                    dimosApp-aarch64-linux = linuxApp "aarch64";
                    dimosApp-x86_64-linux = linuxApp "x86_64";
                });
        };
}
