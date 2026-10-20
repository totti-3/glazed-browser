import sys, uuid
sys.path.insert(0, '.')
from mkmsi import *

VERSION = sys.argv[1]; SETUP = sys.argv[2]; OUT = sys.argv[3]
NS = uuid.UUID('7d1b6c3a-5f0e-4a52-9c1e-6a2f3b8d9e10')
UPGRADE = '{' + str(uuid.uuid5(NS, 'glazed-upgrade')).upper() + '}'
PRODUCT = '{' + str(uuid.uuid5(NS, 'glazed-product-' + VERSION)).upper() + '}'
COMP = '{' + str(uuid.uuid5(NS, 'glazed-component-registry')).upper() + '}'
PACKAGE = '{' + str(uuid.uuid4()).upper() + '}'

m = MSI()
m.table('Property', [('Property', S(72, pk=True)), ('Value', S(0, loc=True))])
m.table('Directory', [('Directory', S(72, pk=True)), ('Directory_Parent', S(72, null=True)), ('DefaultDir', S(255, loc=True))])
m.table('Component', [('Component', S(72, pk=True)), ('ComponentId', S(38, null=True)), ('Directory_', S(72)),
                      ('Attributes', I2()), ('Condition', S(255, null=True)), ('KeyPath', S(72, null=True))])
m.table('Feature', [('Feature', S(38, pk=True)), ('Feature_Parent', S(38, null=True)), ('Title', S(64, null=True, loc=True)),
                    ('Description', S(255, null=True, loc=True)), ('Display', I2(null=True)), ('Level', I2()),
                    ('Directory_', S(72, null=True)), ('Attributes', I2())])
m.table('FeatureComponents', [('Feature_', S(38, pk=True)), ('Component_', S(72, pk=True))])
m.table('Registry', [('Registry', S(72, pk=True)), ('Root', I2()), ('Key', S(255, loc=True)), ('Name', S(255, null=True, loc=True)),
                     ('Value', S(0, null=True, loc=True)), ('Component_', S(72))])
m.table('Binary', [('Name', S(72, pk=True)), ('Data', BIN())])
m.table('CustomAction', [('Action', S(72, pk=True)), ('Type', I2()), ('Source', S(64, null=True)),
                         ('Target', S(255, null=True)), ('ExtendedType', I4(null=True))])
m.table('InstallExecuteSequence', [('Action', S(72, pk=True)), ('Condition', S(255, null=True)), ('Sequence', I2(null=True))])
m.table('Upgrade', [('UpgradeCode', S(38, pk=True)), ('VersionMin', S(20, pk=True, null=True)), ('VersionMax', S(20, pk=True, null=True)),
                    ('Language', S(255, pk=True, null=True)), ('Attributes', I4(pk=True)), ('Remove', S(255, null=True)),
                    ('ActionProperty', S(72))])

# --- standard tables the Windows Installer engine expects to exist (even when empty) ---------
m.table('File', [('File', S(72, pk=True)), ('Component_', S(72)), ('FileName', S(255, loc=True)), ('FileSize', I4()),
                 ('Version', S(72, null=True)), ('Language', S(20, null=True)), ('Attributes', I2(null=True)), ('Sequence', I2())])
m.table('Media', [('DiskId', I2(pk=True)), ('LastSequence', I2()), ('DiskPrompt', S(64, null=True, loc=True)),
                  ('Cabinet', S(255, null=True)), ('VolumeLabel', S(32, null=True)), ('Source', S(72, null=True))])
m.table('Condition', [('Feature_', S(38, pk=True)), ('Level', I2(pk=True)), ('Condition', S(255, null=True))])
m.table('LaunchCondition', [('Condition', S(255, pk=True)), ('Description', S(255, loc=True))])
for _t in ('AdminExecuteSequence', 'AdvtExecuteSequence', 'InstallUISequence'):
    m.table(_t, [('Action', S(72, pk=True)), ('Condition', S(255, null=True)), ('Sequence', I2(null=True))])

props = {
    'ProductName': 'Glazed Browser', 'ProductVersion': VERSION, 'Manufacturer': 'Glazed', 'ProductCode': PRODUCT,
    'UpgradeCode': UPGRADE, 'ProductLanguage': '1033', 'ALLUSERS': '1', 'ARPNOMODIFY': '1', 'ARPNOREPAIR': '1',
    'ARPCOMMENTS': 'Glazed Browser - a refined Chromium-based browser', 'INSTALLLEVEL': '1',
}
for k, v in props.items(): m.row('Property', k, v)

m.row('Directory', 'TARGETDIR', None, 'SourceDir')
m.row('Directory', 'ProgramFiles64Folder', 'TARGETDIR', '.')
m.row('Directory', 'INSTALLFOLDER', 'ProgramFiles64Folder', 'Glazed')

m.row('Component', 'GlazedRegistry', COMP, 'INSTALLFOLDER', 256 | 4, None, 'RegInstallDir')   # 64-bit + registry key path
m.row('Feature', 'Main', None, 'Glazed Browser', 'The Glazed browser', 1, 1, 'INSTALLFOLDER', 0)
m.row('FeatureComponents', 'Main', 'GlazedRegistry')
m.row('Registry', 'RegInstallDir', 2, 'Software\\Glazed', 'InstallDir', '[INSTALLFOLDER]', 'GlazedRegistry')
m.row('Registry', 'RegVersion', 2, 'Software\\Glazed', 'Version', VERSION, 'GlazedRegistry')

m.row('Media', 1, 0, None, None, None, None)
m.row('Binary', 'GlazedSetupExe', 1)
m.add_binary('GlazedSetupExe', open(SETUP, 'rb').read())

# type 2 (exe stored in Binary table) + 0x400 deferred + 0x800 no impersonation (runs elevated)
CA = 2 | 0x400 | 0x800
m.row('CustomAction', 'GlazedInstallFiles', CA, 'GlazedSetupExe',
      'install --dir "[INSTALLFOLDER]." --user "[%USERPROFILE]" --msi "[OriginalDatabase]"', None)
m.row('CustomAction', 'GlazedRemoveFiles', CA, 'GlazedSetupExe',
      'uninstall --dir "[INSTALLFOLDER]." --user "[%USERPROFILE]"', None)

seq = [('FindRelatedProducts', None, 200), ('CostInitialize', None, 800), ('FileCost', None, 900), ('CostFinalize', None, 1000),
       ('InstallValidate', None, 1400), ('RemoveExistingProducts', None, 1450), ('InstallInitialize', None, 1500),
       ('ProcessComponents', None, 1600), ('GlazedRemoveFiles', 'REMOVE="ALL"', 1700), ('UnpublishFeatures', None, 1800),
       ('RemoveRegistryValues', None, 2600), ('WriteRegistryValues', None, 5000), ('GlazedInstallFiles', 'NOT REMOVE', 5500),
       ('RegisterProduct', None, 6100), ('PublishFeatures', None, 6300), ('PublishProduct', None, 6400), ('InstallFinalize', None, 6600)]
for a, c, n in seq: m.row('InstallExecuteSequence', a, c, n)

# dialog-less UI sequence: costing, then hand over to the execute sequence
for a, c, n in [('FindRelatedProducts', None, 200), ('CostInitialize', None, 800), ('FileCost', None, 900),
                ('CostFinalize', None, 1000), ('ExecuteAction', None, 1300)]:
    m.row('InstallUISequence', a, c, n)

# major upgrade: remove every older Glazed version
m.row('Upgrade', UPGRADE, '0.0.0', VERSION, None, 256, None, 'PREVIOUSVERSIONSINSTALLED')

summ = summary_info('Installation Database', 'Glazed Browser', 'Glazed', 'Installer', 'Glazed Browser installer',
                    'x64;1033', PACKAGE, 200, 2, 'Glazed MSI builder')
open(OUT, 'wb').write(m.build(summ))
print('wrote', OUT, 'ProductCode', PRODUCT)
