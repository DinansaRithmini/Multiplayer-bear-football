/**
 * Simple GLTF Loader compatible with global THREE object
 * This is a minimal implementation for basic GLTF model loading
 */

(function() {
    'use strict';

    if (typeof THREE === 'undefined') {
        console.error('THREE is not defined. Make sure to load three.js before GLTFLoader.js');
        return;
    }

    class GLTFLoader extends THREE.Loader {
        constructor(manager) {
            super(manager);
        }

        load(url, onLoad, onProgress, onError) {
            const scope = this;
            const loader = new THREE.FileLoader(this.manager);
            
            loader.setPath(this.path);
            loader.setResponseType('arraybuffer');
            loader.setRequestHeader(this.requestHeader);
            loader.setWithCredentials(this.withCredentials);

            loader.load(url, function(data) {
                try {
                    scope.parse(data, THREE.LoaderUtils.extractUrlBase(url), onLoad, onError);
                } catch (e) {
                    if (onError) {
                        onError(e);
                    } else {
                        console.error(e);
                    }
                }
            }, onProgress, onError);
        }

        parse(data, path, onLoad, onError) {
            let json;
            let binaryData = null;
            const textDecoder = new TextDecoder();

            // Handle binary or JSON glTF
            if (typeof data === 'string') {
                json = JSON.parse(data);
            } else {
                // Check if it's binary glTF
                const magic = textDecoder.decode(new Uint8Array(data, 0, 4));
                if (magic === 'glTF') {
                    // Parse binary glTF
                    const header = new Uint32Array(data, 0, 3);
                    const version = header[1];
                    const length = header[2];
                    
                    if (version < 2.0) {
                        throw new Error('GLTFLoader: Only glTF 2.0 is supported');
                    }

                    // Find JSON and BIN chunks
                    let chunkStart = 12;
                    while (chunkStart < length) {
                        const chunkHeader = new Uint32Array(data, chunkStart, 2);
                        const chunkLength = chunkHeader[0];
                        const chunkType = chunkHeader[1];
                        
                        if (chunkType === 0x4E4F534A) { // JSON chunk
                            const jsonData = new Uint8Array(data, chunkStart + 8, chunkLength);
                            json = JSON.parse(textDecoder.decode(jsonData));
                        } else if (chunkType === 0x004E4942) { // BIN chunk
                            binaryData = data.slice(chunkStart + 8, chunkStart + 8 + chunkLength);
                        }
                        
                        chunkStart += 8 + chunkLength;
                    }
                } else {
                    json = JSON.parse(textDecoder.decode(data));
                }
            }

            if (!json) {
                throw new Error('GLTFLoader: Failed to parse glTF data');
            }

            // Create a simple parser
            const parser = new GLTFParser(json, path, this, binaryData);
            parser.parse(onLoad, onError);
        }
    }

    class GLTFParser {
        constructor(json, path, loader, binaryData = null) {
            this.json = json;
            this.path = path;
            this.loader = loader;
            this.binaryData = binaryData;
            this.cache = {};
        }

        parse(onLoad, onError) {
            const json = this.json;
            
            try {
                // Load the default scene
                const sceneIndex = json.scene !== undefined ? json.scene : 0;
                Promise.all([
                    this.loadScene(sceneIndex),
                    this.loadAnimations()
                ]).then(([scene, animations]) => {
                    const result = {
                        scene: scene,
                        scenes: [scene],
                        animations: animations,
                        cameras: [],
                        asset: json.asset || {},
                        parser: this,
                        userData: {}
                    };
                    onLoad(result);
                }).catch(onError);
            } catch (error) {
                if (onError) onError(error);
            }
        }

        async loadScene(sceneIndex) {
            const sceneDef = this.json.scenes[sceneIndex];
            const scene = new THREE.Group();
            
            if (sceneDef.name) scene.name = sceneDef.name;

            if (sceneDef.nodes) {
                const nodes = await Promise.all(
                    sceneDef.nodes.map(nodeIndex => this.loadNode(nodeIndex))
                );
                nodes.forEach(node => scene.add(node));
            }

            return scene;
        }

        async loadAnimations() {
            if (!this.json.animations || this.json.animations.length === 0) {
                return [];
            }

            const animations = [];
            for (let i = 0; i < this.json.animations.length; i++) {
                const animation = await this.loadAnimation(i);
                if (animation) animations.push(animation);
            }
            return animations;
        }

        async loadAnimation(animationIndex) {
            const animationDef = this.json.animations[animationIndex];
            const tracks = [];

            for (const channel of animationDef.channels) {
                const sampler = animationDef.samplers[channel.sampler];
                const target = channel.target;

                // Load input (time) and output (values) accessors
                const inputAccessor = await this.loadAccessor(sampler.input);
                const outputAccessor = await this.loadAccessor(sampler.output);

                if (!inputAccessor || !outputAccessor) continue;

                const times = inputAccessor.array;
                const values = outputAccessor.array;

                // Create the appropriate track type based on the target path
                let TrackType;
                let trackName = target.path;

                if (target.path === 'translation') {
                    TrackType = THREE.VectorKeyframeTrack;
                    trackName = 'position';
                } else if (target.path === 'rotation') {
                    TrackType = THREE.QuaternionKeyframeTrack;
                    trackName = 'quaternion';
                } else if (target.path === 'scale') {
                    TrackType = THREE.VectorKeyframeTrack;
                } else if (target.path === 'weights') {
                    TrackType = THREE.NumberKeyframeTrack;
                    trackName = 'morphTargetInfluences';
                } else {
                    continue; // Unsupported track type
                }

                // Find the target node name - use index as backup if no name
                let nodeName;
                if (this.json.nodes && this.json.nodes[target.node] && this.json.nodes[target.node].name) {
                    nodeName = this.json.nodes[target.node].name;
                } else {
                    nodeName = `Object_${target.node}`;
                }

                const track = new TrackType(`${nodeName}.${trackName}`, times, values);
                tracks.push(track);
            }

            const clip = new THREE.AnimationClip(animationDef.name || `animation_${animationIndex}`, -1, tracks);
            return clip;
        }

        async loadNode(nodeIndex) {
            if (this.cache['node:' + nodeIndex]) {
                return this.cache['node:' + nodeIndex];
            }

            const nodeDef = this.json.nodes[nodeIndex];
            const node = new THREE.Group();

            if (nodeDef.name) node.name = nodeDef.name;

            // Apply transformations
            if (nodeDef.matrix) {
                const matrix = new THREE.Matrix4();
                matrix.fromArray(nodeDef.matrix);
                node.applyMatrix4(matrix);
            } else {
                if (nodeDef.translation) {
                    node.position.fromArray(nodeDef.translation);
                }
                if (nodeDef.rotation) {
                    node.quaternion.fromArray(nodeDef.rotation);
                }
                if (nodeDef.scale) {
                    node.scale.fromArray(nodeDef.scale);
                }
            }

            // Load mesh if present
            if (nodeDef.mesh !== undefined) {
                const mesh = await this.loadMesh(nodeDef.mesh);
                node.add(mesh);
            }

            // Load children
            if (nodeDef.children) {
                const children = await Promise.all(
                    nodeDef.children.map(childIndex => this.loadNode(childIndex))
                );
                children.forEach(child => node.add(child));
            }

            this.cache['node:' + nodeIndex] = node;
            return node;
        }

        async loadMesh(meshIndex) {
            if (this.cache['mesh:' + meshIndex]) {
                return this.cache['mesh:' + meshIndex];
            }

            const meshDef = this.json.meshes[meshIndex];
            const primitives = meshDef.primitives;

            if (primitives.length === 1) {
                const mesh = await this.loadPrimitive(primitives[0]);
                if (meshDef.name) mesh.name = meshDef.name;
                this.cache['mesh:' + meshIndex] = mesh;
                return mesh;
            } else {
                const group = new THREE.Group();
                const meshes = await Promise.all(
                    primitives.map(primitive => this.loadPrimitive(primitive))
                );
                meshes.forEach(mesh => group.add(mesh));
                if (meshDef.name) group.name = meshDef.name;
                this.cache['mesh:' + meshIndex] = group;
                return group;
            }
        }

        async loadPrimitive(primitiveDef) {
            const geometry = await this.loadGeometry(primitiveDef);
            const material = await this.loadMaterial(primitiveDef.material);
            
            // Create appropriate mesh type based on mode
            const mode = primitiveDef.mode !== undefined ? primitiveDef.mode : 4; // TRIANGLES
            
            let mesh;
            if (mode === 4) { // TRIANGLES
                mesh = new THREE.Mesh(geometry, material);
            } else if (mode === 1) { // LINES
                mesh = new THREE.LineSegments(geometry, material);
            } else if (mode === 0) { // POINTS
                mesh = new THREE.Points(geometry, material);
            } else {
                mesh = new THREE.Mesh(geometry, material); // Fallback
            }

            return mesh;
        }

        async loadGeometry(primitiveDef) {
            const geometry = new THREE.BufferGeometry();
            const attributes = primitiveDef.attributes;

            // Load position attribute
            if (attributes.POSITION !== undefined) {
                const accessor = await this.loadAccessor(attributes.POSITION);
                geometry.setAttribute('position', accessor);
            }

            // Load normal attribute
            if (attributes.NORMAL !== undefined) {
                const accessor = await this.loadAccessor(attributes.NORMAL);
                geometry.setAttribute('normal', accessor);
            }

            // Load UV attribute
            if (attributes.TEXCOORD_0 !== undefined) {
                const accessor = await this.loadAccessor(attributes.TEXCOORD_0);
                geometry.setAttribute('uv', accessor);
            }

            // Load indices
            if (primitiveDef.indices !== undefined) {
                const accessor = await this.loadAccessor(primitiveDef.indices);
                geometry.setIndex(accessor);
            }

            return geometry;
        }

        async loadAccessor(accessorIndex) {
            if (this.cache['accessor:' + accessorIndex]) {
                return this.cache['accessor:' + accessorIndex];
            }

            const accessorDef = this.json.accessors[accessorIndex];
            const bufferView = await this.loadBufferView(accessorDef.bufferView);
            
            const componentTypes = {
                5120: Int8Array,    // BYTE
                5121: Uint8Array,   // UNSIGNED_BYTE
                5122: Int16Array,   // SHORT
                5123: Uint16Array,  // UNSIGNED_SHORT
                5125: Uint32Array,  // UNSIGNED_INT
                5126: Float32Array  // FLOAT
            };

            const typeSizes = {
                'SCALAR': 1,
                'VEC2': 2,
                'VEC3': 3,
                'VEC4': 4,
                'MAT2': 4,
                'MAT3': 9,
                'MAT4': 16
            };

            const TypedArray = componentTypes[accessorDef.componentType];
            const itemSize = typeSizes[accessorDef.type];
            const byteOffset = accessorDef.byteOffset || 0;

            const array = new TypedArray(
                bufferView, 
                byteOffset, 
                accessorDef.count * itemSize
            );

            const bufferAttribute = new THREE.BufferAttribute(array, itemSize);
            
            if (accessorDef.normalized) {
                bufferAttribute.normalized = true;
            }

            this.cache['accessor:' + accessorIndex] = bufferAttribute;
            return bufferAttribute;
        }

        async loadBufferView(bufferViewIndex) {
            if (this.cache['bufferView:' + bufferViewIndex]) {
                return this.cache['bufferView:' + bufferViewIndex];
            }

            const bufferViewDef = this.json.bufferViews[bufferViewIndex];
            const buffer = await this.loadBuffer(bufferViewDef.buffer);
            
            const byteOffset = bufferViewDef.byteOffset || 0;
            const byteLength = bufferViewDef.byteLength;
            
            const bufferView = buffer.slice(byteOffset, byteOffset + byteLength);
            
            this.cache['bufferView:' + bufferViewIndex] = bufferView;
            return bufferView;
        }

        async loadBuffer(bufferIndex) {
            if (this.cache['buffer:' + bufferIndex]) {
                return this.cache['buffer:' + bufferIndex];
            }

            const bufferDef = this.json.buffers[bufferIndex];
            
            if (bufferDef.uri) {
                // Load external buffer
                const url = THREE.LoaderUtils.resolveURL(bufferDef.uri, this.path);
                const response = await fetch(url);
                const buffer = await response.arrayBuffer();
                this.cache['buffer:' + bufferIndex] = buffer;
                return buffer;
            } else if (this.binaryData && bufferIndex === 0) {
                // Use embedded binary data for the first buffer (common in .glb files)
                this.cache['buffer:' + bufferIndex] = this.binaryData;
                return this.binaryData;
            } else {
                throw new Error('GLTFLoader: Missing buffer URI and no embedded binary data');
            }
        }

        async loadTexture(textureIndex) {
            console.log(`Loading texture ${textureIndex}...`);
            
            if (this.cache['texture:' + textureIndex]) {
                console.log(`✓ Texture ${textureIndex} found in cache`);
                return this.cache['texture:' + textureIndex];
            }

            const textureDef = this.json.textures[textureIndex];
            console.log('Texture definition:', textureDef);
            
            const imageDef = this.json.images[textureDef.source];
            console.log('Image definition:', imageDef);

            let imageUrl;
            if (imageDef.uri) {
                // External image file
                console.log('Loading external image:', imageDef.uri);
                imageUrl = THREE.LoaderUtils.resolveURL(imageDef.uri, this.path);
            } else if (imageDef.bufferView !== undefined) {
                // Image embedded in buffer
                console.log('Loading embedded image from bufferView:', imageDef.bufferView);
                console.log('MIME type:', imageDef.mimeType);
                
                try {
                    const bufferView = await this.loadBufferView(imageDef.bufferView);
                    console.log('Buffer view loaded, size:', bufferView.byteLength, 'bytes');
                    
                    const blob = new Blob([bufferView], { type: imageDef.mimeType });
                    imageUrl = URL.createObjectURL(blob);
                    console.log('Created blob URL:', imageUrl);
                } catch (error) {
                    console.error('Failed to load buffer view for image:', error);
                    return null;
                }
            } else {
                console.warn('GLTFLoader: Image source not found');
                return null;
            }

            return new Promise((resolve, reject) => {
                const loader = new THREE.TextureLoader();
                loader.load(imageUrl, 
                    (texture) => {
                        texture.flipY = false; // glTF images are not flipped
                        texture.wrapS = THREE.RepeatWrapping;
                        texture.wrapT = THREE.RepeatWrapping;
                        
                        // Improve texture quality
                        texture.generateMipmaps = true;
                        texture.minFilter = THREE.LinearMipmapLinearFilter;
                        texture.magFilter = THREE.LinearFilter;
                        
                        // Set proper color space for base color textures
                        texture.colorSpace = THREE.SRGBColorSpace;
                        
                        // Apply sampler settings if available
                        if (textureDef.sampler !== undefined) {
                            const samplerDef = this.json.samplers[textureDef.sampler];
                            if (samplerDef) {
                                if (samplerDef.wrapS !== undefined) {
                                    texture.wrapS = samplerDef.wrapS === 33071 ? THREE.ClampToEdgeWrapping : 
                                                   samplerDef.wrapS === 33648 ? THREE.MirroredRepeatWrapping : 
                                                   THREE.RepeatWrapping;
                                }
                                if (samplerDef.wrapT !== undefined) {
                                    texture.wrapT = samplerDef.wrapT === 33071 ? THREE.ClampToEdgeWrapping : 
                                                   samplerDef.wrapT === 33648 ? THREE.MirroredRepeatWrapping : 
                                                   THREE.RepeatWrapping;
                                }
                                if (samplerDef.magFilter !== undefined) {
                                    texture.magFilter = samplerDef.magFilter === 9728 ? THREE.NearestFilter : THREE.LinearFilter;
                                }
                                if (samplerDef.minFilter !== undefined) {
                                    const minFilters = {
                                        9728: THREE.NearestFilter,
                                        9729: THREE.LinearFilter,
                                        9984: THREE.NearestMipmapNearestFilter,
                                        9985: THREE.LinearMipmapNearestFilter,
                                        9986: THREE.NearestMipmapLinearFilter,
                                        9987: THREE.LinearMipmapLinearFilter
                                    };
                                    texture.minFilter = minFilters[samplerDef.minFilter] || THREE.LinearMipmapLinearFilter;
                                }
                            }
                        }
                        
                        this.cache['texture:' + textureIndex] = texture;
                        resolve(texture);
                    },
                    undefined,
                    (error) => {
                        console.error('GLTFLoader: Failed to load texture', error);
                        reject(error);
                    }
                );
            });
        }

        async loadMaterial(materialIndex) {
            if (materialIndex === undefined) {
                // Return default material
                return new THREE.MeshStandardMaterial({ color: 0xcccccc });
            }

            // Don't use cache for materials with textures to ensure proper texture loading
            // if (this.cache['material:' + materialIndex]) {
            //     return this.cache['material:' + materialIndex];
            // }

            const materialDef = this.json.materials[materialIndex];
            const material = new THREE.MeshStandardMaterial();

            if (materialDef.name) material.name = materialDef.name;

            // Handle PBR metallic roughness
            if (materialDef.pbrMetallicRoughness) {
                const pbr = materialDef.pbrMetallicRoughness;
                
                if (pbr.baseColorFactor) {
                    material.color.fromArray(pbr.baseColorFactor);
                    if (pbr.baseColorFactor[3] < 1.0) {
                        material.transparent = true;
                        material.opacity = pbr.baseColorFactor[3];
                    }
                }

                // Load base color texture (diffuse map)
                if (pbr.baseColorTexture !== undefined) {
                    console.log('Loading base color texture, index:', pbr.baseColorTexture.index);
                    try {
                        const texture = await this.loadTexture(pbr.baseColorTexture.index);
                        if (texture) {
                            material.map = texture;
                            console.log('✓ Base color texture loaded successfully');
                        } else {
                            console.warn('✗ Base color texture loading returned null');
                        }
                    } catch (error) {
                        console.error('✗ Failed to load base color texture:', error);
                    }
                }

                if (pbr.metallicFactor !== undefined) {
                    material.metalness = pbr.metallicFactor;
                }

                if (pbr.roughnessFactor !== undefined) {
                    material.roughness = pbr.roughnessFactor;
                }
            }

            // Handle double sided
            if (materialDef.doubleSided) {
                material.side = THREE.DoubleSide;
            }

            // Don't cache materials to ensure textures are properly applied
            // this.cache['material:' + materialIndex] = material;
            return material;
        }
    }

    // Attach to THREE namespace
    THREE.GLTFLoader = GLTFLoader;

})();