{
    description = "dim-controller: drive a running dimOS robot with its live 3D view, cameras and recording, as a dimOS Desktop app";

    inputs = {
        nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
        rust-overlay.url = "github:oxalica/rust-overlay";
        rust-overlay.inputs.nixpkgs.follows = "nixpkgs";
    };
    nixConfig = {
        extra-substituters = [ "https://dimos-desktop.cachix.org" ];
        extra-trusted-public-keys = [ "dimos-desktop.cachix.org-1:A4P35aGJGmCan92LWyamtSFXMqaVE+VRFYnrJ8QMTeQ=" ];
    };

    outputs = { self, nixpkgs, rust-overlay }:
        let
            systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
            forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; overlays = [ (import rust-overlay) ]; }));
        in {
            packages = forAllSystems (pkgs:
                let
                    rust = pkgs.rust-bin.stable.latest.default;
                    rustPlatform = pkgs.makeRustPlatform { cargo = rust; rustc = rust; };

                    # the page: React + Vite (type-checked first), from package-lock.json
                    frontend = pkgs.buildNpmPackage {
                        pname = "dim-controller-frontend";
                        version = "0.1.0";
                        src = ./frontend;
                        npmDepsHash = "sha256-WYspSBdYS0dfOrO1GfsTTCJOP1r3bAe2OsRHN20bs4E=";
                        installPhase = ''
                            cp -r dist $out
                        '';
                    };

                    # the backend: serves the page and records topics to mcap (independent of the page, so a page
                    # change doesn't rebuild it)
                    server = rustPlatform.buildRustPackage {
                        pname = "dim-controller-server";
                        version = "0.1.0";
                        src = ./server;
                        cargoLock.lockFile = ./server/Cargo.lock;
                        # the tests open zenoh sessions on loopback; `cargo test` runs them in development
                        doCheck = false;
                    };

                    # <arch> Linux from any machine: a static musl binary linked by zig, so no Linux builder or cross gcc
                    crossServer = arch:
                        let
                            target = "${arch}-unknown-linux-musl";
                            rustCross = rust.override { targets = [ target ]; };
                        in
                        (pkgs.makeRustPlatform { cargo = rustCross; rustc = rustCross; }).buildRustPackage {
                            pname = "dim-controller-server-${arch}-linux";
                            version = "0.1.0";
                            src = ./server;
                            cargoLock.lockFile = ./server/Cargo.lock;
                            nativeBuildInputs = [ pkgs.cargo-zigbuild pkgs.zig ];
                            # cargo-auditable's -Wl,--undefined is a flag zig's linker rejects
                            auditable = false;
                            buildPhase = ''
                                export HOME=$TMPDIR ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig
                                cargo zigbuild --release --offline --target ${target} -p dimos-app-server
                            '';
                            doCheck = false;
                            installPhase = "install -Dm755 target/${target}/release/dimos-app-server $out/bin/dimos-app-server";
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
