# MemOS Memory Plugin Installed

Install the Python dependency:

```bash
pip install MemoryOS
```

If you have not installed MemOS through Hermes yet, install the whole MemOS
project first:

```bash
hermes plugins install MemTensor/MemOS
```

Then link the MemOS app directory into the Hermes memory provider directory:

```bash
mkdir -p ~/.hermes/hermes-agent/plugins/memory
ln -s ~/.hermes/plugins/MemOS/apps/MemOS-Cloud-Hermes-Plugin \
      ~/.hermes/hermes-agent/plugins/memory/memos
```

Then run setup to activate it:

```bash
hermes memory setup
```

Choose `memos` in the setup wizard.
